// Print the REAL page count of every resume in a rows file: the one-page rule's measuring stick.
//
// Usage (from worker/, Bash, with the wrong-account token unset per CLAUDE.md section 4):
//   echo "select id, status, tailored_profile from applications where status in ('awaiting_approval','approved') and tailored_profile is not null" > q.sql
//   env -u SUPABASE_ACCESS_TOKEN supabase db query --linked -f q.sql > rows.json
//   node src/cli/resume-pages.ts rows.json
//
// Read-only: it renders locally and writes nothing anywhere. Built for the orchestrator's
// re-measure of the 11 two-page rows after the template deploy (2026-11-07). Each line is one
// row: its id, status, the typography step renderResumeHtml picked, the model's verdict at the
// minimum (fitsOnePage), and the real page count from Chromium's page.pdf() via pdf.js.
// Uses the same HTML and the same page.pdf() options as renderResumePdf, but NOT renderResumePdf
// itself: that one throws on a two-page resume (the submit gate), and here the count is the point.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import type { ResolvedResume } from '@applyy/shared-types';
import { articleOf, fitsOnePage, flowOf, pickStepIndex, renderResumeHtml } from '@applyy/resume-template';
import { countPdfPages } from '../render-resume-pdf.ts';

// The rows file: `supabase db query --json` output, { rows: [...] }.
const path = process.argv[2];
// No file named: say how to call it, and fail.
if (path === undefined) {
  // To stderr, so stdout stays machine-readable.
  console.error('usage: node src/cli/resume-pages.ts <rows.json>');
  // Non-zero: nothing was measured.
  process.exit(2);
}

// The rows, shape-checked: an array of objects with an id and a profile, or this is not a rows file.
const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
// The array inside.
const rows = (parsed as { rows?: unknown }).rows;
// A file without a rows array measures nothing; refuse rather than print an empty "all fine".
if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${path}: no rows array (expected supabase db query output)`);

// One browser for the whole run.
const browser = await chromium.launch();
// Closed even if a render throws.
try {
  // One page, reused, as the worker does.
  const page = await browser.newPage();
  // Each row in file order.
  for (const row of rows as { id: string; status?: string; tailored_profile: ResolvedResume }[]) {
    // The document exactly as the preview and the worker render it.
    const html = renderResumeHtml(row.tailored_profile);
    // Same call and options as renderResumePdf.
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    // A4, no Playwright margins, backgrounds, no header/footer.
    const pdf = await page.pdf({ format: 'A4', margin: { top: '0', right: '0', bottom: '0', left: '0' }, printBackground: true, displayHeaderFooter: false });
    // One JSON line per row.
    console.log(JSON.stringify({
      // Which row.
      id: row.id,
      // Its status, when the query selected it.
      status: row.status ?? null,
      // The typography step the renderer picked (0 = full size).
      step: pickStepIndex(flowOf(articleOf(html))),
      // The model's answer at the readable minimum.
      fitsOnePage: fitsOnePage(row.tailored_profile),
      // The real count.
      pages: await countPdfPages(new Uint8Array(pdf)),
    }));
  }
} finally {
  // Always released.
  await browser.close();
}
