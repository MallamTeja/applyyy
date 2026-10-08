/* Pure helpers behind the resume preview: render a resume with the worker's own
 * renderer, render the master the same way, and name the document for download.
 *
 * WHY THE SHARED RENDERER AND NOT A REACT RE-DRAWING. The worker makes the uploaded PDF
 * with `renderResumeHtml` (worker/src/render-resume-pdf.ts:24), and the template's own
 * cross-runtime test pins that Node and Deno produce identical bytes from it. A preview
 * drawn by different code would show the operator a DIFFERENT artefact from the one that
 * gets submitted. Calling the same function makes the preview a derivation, not a likeness.
 *
 * WHY A RELATIVE IMPORT. `@applyy/resume-template` is a dependency of `worker` only, and
 * adding it to apps/web means a package.json edit plus a lockfile write in a tree several
 * sessions share (CLAUDE.md section 4). The package has no build step and its exports
 * point at .ts source, so the relative path reaches the same file the bare specifier
 * would. Its one bare import is `import type` from `@applyy/shared-types`, which apps/web
 * already depends on and which is erased at build time.
 *
 * PURE ON PURPOSE: no React, no DOM, no network. That is what lets `node --test` exercise
 * all of it, since apps/web has no component render harness.
 */

// The one renderer the worker also uses, and its escaper, reached by path (see header).
import { escapeHtml, renderResumeHtml, ResumeRenderError } from '../../../../../packages/resume-template/src/index.ts';
// The snapshot type stored in `applications.tailored_profile`, and the master's type.
import type { MasterProfile, ResolvedResume } from '../../data/contract';

// A closed union, not a nullable string: a caller must decide what to show for a failed
// render before it can reach the HTML, so a failure cannot be painted as a blank frame.
export type ResumePreview =
  // The full HTML document, ready for an iframe's srcdoc and for a download.
  | { readonly kind: 'rendered'; readonly html: string }
  // The renderer refused this snapshot; `message` says why in the renderer's words.
  | { readonly kind: 'refused'; readonly message: string };

// The renderer's <title> element: exactly one, in <head>, holding escaped text only.
const TITLE_ELEMENT = /<title>[^<]*<\/title>/;

// Render one resume for preview, never throwing. `documentTitle` replaces the <title>,
// because Chrome offers the frame's title as the default Save-as-PDF filename.
export function buildResumePreview(resume: ResolvedResume, documentTitle: string): ResumePreview {
  // The render can throw by design: an unsupported schema_version is a refusal, not a bug.
  let html: string;
  try {
    // Same call, same input as the worker's PDF path; nothing is reshaped on the way in.
    html = renderResumeHtml(resume);
  } catch (error) {
    // The renderer's own refusal carries an operator-readable reason; pass it through.
    if (error instanceof ResumeRenderError) return { kind: 'refused', message: error.message };
    // Anything else is a template defect; the worker would fail the same way, so say so.
    return { kind: 'refused', message: `The resume template failed on this snapshot: ${String(error)}` };
  }
  // ONLY the <title> text changes. The body is the worker's bytes, untouched, so the
  // preview stays the submitted document; the title is browser chrome, not resume content.
  // A renderer without exactly that element is left alone rather than patched blindly.
  const titled = TITLE_ELEMENT.test(html)
    // Escaped with the template's own escaper: job titles and names are scraped text.
    ? html.replace(TITLE_ELEMENT, `<title>${escapeHtml(documentTitle)}</title>`)
    // No title element to replace: the default filename is a nicety, not a reason to fail.
    : html;
  // Rendered and named.
  return { kind: 'rendered', html: titled };
}

// The template's sheet, A4 (its `@page { size: A4 }`), in CSS px at 96 per inch: 210mm.
// The preview lays the resume out at this width so it wraps exactly like the PDF page.
export const PAGE_WIDTH_PX = 794;

// The zoom used before the frame has been measured (and in a server render): small enough
// that a whole A4 width fits a half-width pane, large enough that 10.5pt body stays legible.
export const DEFAULT_PREVIEW_ZOOM = 0.6;

// Zoom bounds shared by "Fit" and the -/+ buttons. One pair, so a fitted value can never sit
// outside what the buttons allow (a "+" that zooms OUT, a "-" that zooms IN).
export const MIN_ZOOM = 0.3;
// Above 1.5 a two-column pane scrolls sideways for no reading benefit.
export const MAX_ZOOM = 1.5;

// Any computed zoom pulled into [MIN_ZOOM, MAX_ZOOM], so every caller shares one rule.
export function clampZoom(zoom: number): number {
  // min/max rather than branches: one expression, no case to miss.
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

// The template's closing </head>, the one place a preview-only stylesheet can go.
const HEAD_CLOSE = '</head>';

// The resume as a sheet of paper scaled by `zoom`, for the FRAME ONLY. Downloads keep
// using `preview.html`, so neither file the operator saves carries any of this.
//
// WHY `@media screen`: "Download PDF" prints this same frame. Print media skips the block,
// so the PDF keeps the template's own @page layout at 100% instead of a shrunken copy.
// WHY CSS `zoom`, not transform: zoom changes layout size, so the frame's scrollbar
// matches the shrunken page; a transform leaves the full-size scroll height behind.
// WHY width/padding on body: on screen the body would otherwise stretch to the frame and
// rewrap the text; 210mm with the @page's 14mm inset (border-box, set by the template)
// reproduces the printed line breaks.
export function zoomedPreviewHtml(html: string, zoom: number): string {
  // NaN, Infinity or a non-positive zoom would print `zoom:NaN`, which the browser drops
  // silently; refusing it here makes the wrong value unrepresentable in the frame (§6).
  if (!Number.isFinite(zoom) || zoom <= 0) return html;
  // The style lives in the head, after the template's own sheet, so it wins on equal specificity.
  // `data-preview-zoom` names it, so a test can find it without matching prose.
  const style = `<style data-preview-zoom>@media screen{html{zoom:${zoom}}body{width:210mm;min-height:297mm;padding:14mm}}</style>`;
  // The renderer always emits </head>; without one, show the document unzoomed rather
  // than splice a style into an unknown shape - a full-size preview is still the right resume.
  return html.includes(HEAD_CLOSE) ? html.replace(HEAD_CLOSE, `${style}${HEAD_CLOSE}`) : html;
}

// "<Name> - <Company> - tailored", the default filename for a download. Characters that
// file systems refuse are dropped here, because the browser derives the name from it.
export function previewDocumentTitle(fullName: string, companyName: string, variant: 'tailored' | 'master'): string {
  // Windows forbids these in file names; Chrome substitutes them unpredictably.
  const clean = (text: string) => text.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  // The master is not about any company, so it carries the version-free word only.
  return variant === 'master'
    ? `${clean(fullName)} - master`
    // Company first-class in the name, so a folder of downloads sorts by employer.
    : `${clean(fullName)} - ${clean(companyName)} - tailored`;
}

// The master profile as a renderable resume: EVERY node, in master order, untailored.
//
// WHY THIS IS SAFE TO WRITE HERE: it is a structural rename, not a selection. Each master
// node becomes its resolved twin (`id` -> `ref`, bullet text copied into both `text` and
// `master_text`), so the rendered page is the master verbatim. It never feeds the Tailor,
// the validator or the worker - it exists only so the operator can see what the tailoring
// started from, side by side, through the same renderer.
export function masterAsResume(master: MasterProfile, masterVersion: number): ResolvedResume {
  // One bullet mapping for every section, so no section can drift in how it copies text.
  const bullets = (list: MasterProfile['experience'][number]['bullets']) =>
    // Text and master_text are equal by definition: nothing was reworded.
    list.map((b) => ({ ref: b.id, text: b.text, master_text: b.text }));
  return {
    // The only schema the renderer accepts; the master carries the same version marker.
    schema_version: master.schema_version,
    // The version this render is OF, so the document is traceable to its row.
    master_version: masterVersion,
    // Identity is never tailored, so it is identical in both panes.
    identity: master.identity,
    // Every section, in the canonical order, so nothing in the master is hidden.
    section_order: ['summary', 'skills', 'experience', 'projects', 'education', 'achievements', 'certifications'],
    // The master stores the summary as a node; the resume carries its text.
    summary: master.summary?.text ?? null,
    // Skills: id renamed to ref, nothing else.
    skills: master.skills.map((s) => ({ ref: s.id, name: s.name, category: s.category })),
    // Experience: every role, every bullet.
    experience: master.experience.map((e) => ({
      // The node id, renamed.
      ref: e.id,
      // Verbatim fields.
      company: e.company, role: e.role, location: e.location,
      // Display dates are already strings; the machine dates are not rendered.
      start_display: e.start_display, end_display: e.end_display,
      // Every bullet.
      bullets: bullets(e.bullets),
    })),
    // Projects: links carried as-is, as the resolved type does.
    projects: master.projects.map((p) => ({
      // The node id, renamed.
      ref: p.id, name: p.name, links: p.links,
      // Display dates.
      start_display: p.start_display, end_display: p.end_display,
      // Every bullet.
      bullets: bullets(p.bullets),
    })),
    // Education, every field verbatim.
    education: master.education.map((d) => ({
      // The node id, renamed.
      ref: d.id, institution: d.institution, degree: d.degree, field: d.field,
      // Display dates and grade.
      start_display: d.start_display, end_display: d.end_display, grade_display: d.grade_display,
      // Every bullet.
      bullets: bullets(d.bullets),
    })),
    // Achievements. `description ?? null`: stored masters omit the key when empty, and the
    // resolved type wants an explicit null rather than undefined.
    achievements: master.achievements.map((a) => ({ ref: a.id, label: a.label, description: a.description ?? null, bullets: bullets(a.bullets) })),
    // Certifications, same rule for description.
    certifications: master.certifications.map((c) => ({ ref: c.id, label: c.label, description: c.description ?? null, bullets: bullets(c.bullets) })),
  };
}
