// §17.2 END TO END: the real resume template → a real PDF → a real text
// extractor → what an ATS actually reads.
//
// THIS IS THE TEST THE RESUME TEMPLATE CANNOT WRITE FOR ITSELF. That package
// asserts §17.2 compliance structurally — no columns, no tables, real `<ul>`
// elements — and those assertions are a PROXY. They are satisfiable by a
// document that still extracts wrongly, because CSS can column a single `<div>`
// and absolute positioning can reorder text with no table in the markup. The
// proxy also cannot see anything that happens during PDF generation, which is
// where reading order is actually decided.
//
// So the check lives here, in the package that owns `page.pdf()`, and its
// failures go back to the template stream as regression tests.
import { afterAll, beforeAll, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { chromium, type Browser } from 'playwright';
import { checkAtsReadability, extractPdfText } from '../src/ats-parse-check.ts';

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

// The template package's committed golden render. Read as a FILE rather than
// deep-imported, for two reasons: the schema contract forbids deep imports past
// a package's single entry point, and the golden HTML is the actual shipped
// artifact — testing it means testing what really gets printed, not a
// re-derivation of it that could drift.
const GOLDEN_HTML = new URL(
  '../../packages/resume-template/test/fixtures/zomato-backend-intern.golden.html',
  import.meta.url,
);

test('the real resume PDF extracts in reading order with its skills intact', async () => {
  const html = await readFile(GOLDEN_HTML, 'utf8');

  // NON-VACUITY GUARD. If the fixture is ever moved or emptied, this test must
  // fail loudly rather than quietly validating an empty document — an empty
  // page trivially satisfies "extracts in order" and would report §17.2
  // compliance for a resume that does not exist.
  expect(html.length).toBeGreaterThan(1_000);

  const page = await browser.newPage();
  try {
    // `setContent` rather than a file URL so the assertion is about the HTML
    // the template produced, with no chance of the browser resolving something
    // else off disk beside it.
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    // The SAME call the worker uses to produce a submitted resume. Testing a
    // different print path would prove something about a document nobody sends.
    const pdf = await page.pdf({ format: 'A4', printBackground: true });

    const extracted = await extractPdfText(new Uint8Array(pdf));

    // The PDF must have a text layer at all. Stated separately from the
    // readability report so a font or rasterisation regression is named as
    // itself rather than as twenty missing phrases.
    expect(extracted.items.length).toBeGreaterThan(10);

    // What §11's worked example says an honest tailoring contains. PostgreSQL
    // and Docker are deliberately absent from the fixture — they are the
    // fabrication the whole anti-fabrication design exists to prevent — so
    // asserting the HONEST skills survive is the right test, and asserting the
    // dishonest ones are missing is checked below.
    const report = checkAtsReadability(extracted, {
      mustContain: ['Node.js', 'Express', 'REST'],
      // EACH HEADING FOLLOWED BY ITS OWN BODY, alternating. A sequence of
      // headings alone survives two-column scrambling intact and would prove
      // nothing; requiring section N's body to precede section N+1's heading is
      // what makes this an interleaving detector. See ats-parse-check.test.ts.
      inOrder: [
        'SKILLS',
        'Node.js, JavaScript, Python',
        'EXPERIENCE',
        'Backend Developer, College Event Portal',
        'PROJECTS',
        'job application automation',
        'EDUCATION',
        'B.Tech, Computer Science and Engineering',
      ],
    });

    // The actual §17.2 verdict, and the findings are printed rather than
    // swallowed so a failure tells the template stream what to fix.
    if (!report.readable) {
      console.error('[ats] findings:', JSON.stringify(report.findings, null, 2));
    }
    expect(report.readable).toBe(true);

    // THE ANTI-FABRICATION ASSERTION, checked at the last possible moment: the
    // §11 example's two invented skills must not appear in the bytes that would
    // reach an employer. Every earlier layer already prevents this — the Tailor
    // cannot express them, the validator would reject them — so this is
    // defence in depth at the exit, where being wrong is unrecoverable.
    expect(extracted.text).not.toMatch(/PostgreSQL/i);
    expect(extracted.text).not.toMatch(/Docker/i);
  } finally {
    await page.close();
  }
}, 120_000);

test('the SAME resume is caught as unreadable when flex REORDERS it', async () => {
  // THE PROOF THAT THE CHECK ABOVE IS LOAD-BEARING — but arrived at only after
  // the obvious version of this test FAILED, and the reason is worth more than
  // the test.
  //
  // MEASURED MATRIX (Chromium page.pdf() -> pdf.js getTextContent(), this
  // machine, 2026-09-10). Extraction order versus DOM order:
  //
  //   column-count:2 ........ DOM order. NOT scrambled.
  //   display:flex .......... DOM order. NOT scrambled.
  //   display:grid .......... DOM order. NOT scrambled.
  //   float left/right ...... DOM order. NOT scrambled.
  //   position:absolute ..... DOM order. NOT scrambled.
  //   <table> two cells ..... DOM order. NOT scrambled.
  //   flex-direction:row-reverse ... VISUAL order. SCRAMBLED.
  //   flex `order:` .......... VISUAL order. SCRAMBLED.
  //
  // So §17.2's premise does not hold for OUR pipeline the way the plan states
  // it. "A two-column resume parses into interleaved gibberish" is true of PDFs
  // from Word, LaTeX and design tools, which is where the advice comes from —
  // but Chromium emits its text content stream in PAINT order, and paint order
  // equals DOM order for every ordinary side-by-side layout. Printing through a
  // browser is structurally safer than the folklore assumes.
  //
  // What DOES diverge is flexbox visual reordering, where paint order follows
  // the visual result rather than the markup. That is the real hazard for a
  // browser-printed resume, and it is the one this test pins.
  const html = await readFile(GOLDEN_HTML, 'utf8');

  const page = await browser.newPage();
  try {
    // Two independent flows whose VISUAL order is the reverse of their DOM
    // order. Chromium prints what the reader sees, so the extractor sees the
    // second half of the resume first.
    await page.setContent(
      `<div style="display:flex;flex-direction:row-reverse">` +
        `<div>${html}</div><div><h2>ADDENDUM</h2><p>Referees available on request</p></div>` +
        `</div>`,
      { waitUntil: 'domcontentloaded' },
    );
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    const extracted = await extractPdfText(new Uint8Array(pdf));

    // The words are all still present — this is the trap. A "does the resume
    // mention Node.js" check passes happily on this document.
    expect(extracted.text).toMatch(/Node\.js/);

    const report = checkAtsReadability(extracted, {
      mustContain: ['Node.js'],
      // The genuine reading order of the real resume. Reversed by the layout
      // above, so the subsequence cannot be satisfied.
      // Spans BOTH flows. An expectation confined to one flow is satisfied
      // even under reversal, because each flow stays internally ordered — the
      // same weakness that made the first version of this test vacuous. The
      // marker from the second block must come LAST in DOM order, so the
      // visual reversal is what breaks the subsequence.
      inOrder: ['Teja Mallam', 'EXPERIENCE', 'EDUCATION', 'ADDENDUM'],
    });

    // Caught, and caught as a LAYOUT problem rather than a content one.
    expect(report.readable).toBe(false);
    expect(report.findings.map((finding) => finding.kind)).toContain('out_of_order');
  } finally {
    await page.close();
  }
}, 120_000);
