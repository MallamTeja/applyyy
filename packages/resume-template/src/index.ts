/**
 * applyy — @applyy/resume-template public surface.
 *
 * ONE MODULE, THREE RUNTIMES. React imports it to draw the approval preview, the
 * Playwright worker imports it to produce the submitted PDF, and a Supabase Edge
 * Function may import it to pre-render. That single shared import is what makes
 * "what you approved is byte-for-byte what gets sent" structural rather than
 * aspirational (PROJECT_PLAN section 7).
 *
 * Import from '@applyy/resume-template', never from a deep path like
 * '@applyy/resume-template/src/render-resume-html.ts' — a deep import pins the
 * consumer to this package's internal file layout.
 *
 * NO BUILD STEP. package.json exports point at .ts source, which the section 20
 * step 0 spike proved works in all three runtimes: Node v24 strips types
 * natively, Deno reads .ts, Vite transpiles. A dist/ build would only create a
 * second copy of the renderer that could go stale — and a stale renderer is
 * precisely the failure the approval guarantee cannot tolerate.
 */

// The renderer itself, plus its error type so callers can distinguish a contract
// violation (a stale pinned snapshot) from an ordinary bug and fail the
// application loudly instead of submitting a malformed PDF.
// fitsOnePage: the one-page rule's question, asked by the tailor and the web edit gate.
export { renderResumeHtml, ResumeRenderError, fitsOnePage } from './render-resume-html.ts';

// The typography ladder, exported so the calibration test can render and measure every rung.
export { TYPOGRAPHY_LADDER, stepStylesheet, flowOf, flowFits, articleOf, pickStepIndex } from './page-fit.ts';

// The one-skill-group-one-line width model (Teja, 2026-11-12): the tailor, the page trimmer and
// resume-assist all ask these, so "one line" means one thing everywhere.
export { skillGroupLineCount, skillGroupFitsOneLine, fillSkillLine } from './page-fit.ts';

// Exported so the React preview can prove it uses the identical stylesheet
// rather than an approximation. renderResumeHtml already inlines it; this is for
// tooling such as the diff view, not for normal rendering.
export { RESUME_STYLESHEET } from './print-styles.ts';

// Exported because the worker and the Edge Functions render other untrusted-
// derived strings too (the referral note, the cover letter). One escaping
// implementation across the repo is one place to audit, not four.
export { escapeHtml, safeHref } from './escape-html.ts';
