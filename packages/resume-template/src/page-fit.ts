/**
 * applyy — one-page fit: a line model of the resume template, and the typography ladder.
 *
 * THE RULE (Teja, 2026-11-07 22:43 IST): "the tailored resume and the resumes after
 * applying edits need to be in 1 page only, this is rule." His 23:00 ruling on HOW:
 * shrink the typography first (within a readable minimum), and only then remove content.
 *
 * WHY A MODEL AND NOT A BROWSER. The page count's ground truth is Chromium's print layout
 * (the worker's page.pdf() and the web's iframe print() are both Chromium). But this
 * module runs in THREE runtimes, and two of them cannot lay out HTML: the Deno tailor and
 * Node tests. So the fit is ESTIMATED here from the exact markup renderResumeHtml emits,
 * and the estimate is held to the real renderer by worker/test/page-fit-calibration.test.ts,
 * which renders a ladder of resumes in real Chromium under BOTH fonts the stylesheet can
 * resolve to (Georgia on Windows, Times New Roman / Liberation Serif elsewhere) and asserts
 * "the model says it fits at step k" ⇒ "the real PDF is one page at step k".
 * The model may be pessimistic (it then shrinks or trims a little early); it may never be
 * optimistic (that would print page two). Every approximation below therefore errs LONG.
 *
 * WHY THE STEP IS PICKED INSIDE THE RENDERER. The web preview, the web Download PDF and the
 * worker's submitted PDF all call renderResumeHtml. Choosing the step there means all three
 * get the same step by construction: no stored scale field that could disagree between the
 * preview and the PDF, and an edit re-picks the step automatically.
 */

/** One rung of the typography ladder. Every size the stylesheet sets is derived from these. */
export interface TypographyStep {
  // Multiplier on every font size in the stylesheet (body 10.5pt at 1).
  readonly fontScale: number;
  // Unitless body line-height (the stylesheet's own value at step 0).
  readonly lineHeight: number;
  // Multiplier on every vertical gap the stylesheet sets in mm (section, entry, bullet).
  readonly gapScale: number;
  // The @page margin in mm, all four sides.
  readonly pageMarginMm: number;
}

/**
 * THE LADDER, widest first. Step 0 MUST equal print-styles.ts exactly: it adds no CSS, so a
 * resume that already fits renders byte-identical to before this module existed (the golden
 * fixture test proves it). The last rung is the READABLE MINIMUM, stated here once:
 * body 9.5pt (10.5 × 0.905), line-height 1.25, page margin 10mm. Below that a printed
 * resume reads as small print, and ATS text extraction starts to degrade.
 */
export const TYPOGRAPHY_LADDER: readonly TypographyStep[] = [
  // Today's stylesheet, untouched.
  { fontScale: 1, lineHeight: 1.38, gapScale: 1, pageMarginMm: 14 },
  // Air out of the leading and gaps first: the cheapest change a reader notices least.
  { fontScale: 1, lineHeight: 1.3, gapScale: 0.8, pageMarginMm: 12 },
  // Then a half point off the type.
  { fontScale: 0.952, lineHeight: 1.28, gapScale: 0.7, pageMarginMm: 11 },
  // The readable minimum. Nothing renders smaller than this.
  { fontScale: 0.905, lineHeight: 1.25, gapScale: 0.6, pageMarginMm: 10 },
];

// A4 in points (210 × 297 mm), the paper @page declares.
const A4_WIDTH_PT = 595.276;
// Same, for the height.
const A4_HEIGHT_PT = 841.89;
// One millimetre in points; every mm value in the stylesheet goes through this.
const MM = 72 / 25.4;

/**
 * Headroom kept below the page bottom. Covers what the model does not represent exactly
 * (baseline alignment in the flex entry head, sub-point rounding in Chromium's layout
 * units). Set by the calibration test, which fails if it is ever too small.
 */
const SAFETY = 0.97;

// The characters the width tables cover, in table order: printable ASCII then the
// non-ASCII characters resumes actually contain (bullets, dashes, smart quotes, rupee).
const TABLE_CHARS = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~•–—’‘“”…·é₹→';

/*
 * Advance widths in 1/1000 em, MEASURED in Chromium (canvas measureText at 1000px,
 * 2026-11-07) and taken as the per-character MAXIMUM across Georgia and Times New Roman,
 * upright and italic. Liberation Serif is metric-compatible with Times New Roman, so this
 * covers the Linux worker too. The max of the two fonts is what makes one table safe on
 * every machine: whichever font resolves, the real line is no longer than modelled.
 */
const REGULAR_WIDTHS = [250, 334, 420, 644, 610, 834, 778, 216, 375, 375, 500, 675, 270, 375, 270, 469, 614, 500, 559, 552, 565, 529, 566, 503, 597, 566, 384, 384, 675, 675, 675, 500, 929, 723, 667, 667, 750, 654, 611, 726, 815, 390, 518, 723, 611, 928, 768, 745, 611, 745, 702, 562, 619, 757, 723, 976, 723, 723, 611, 390, 469, 390, 644, 644, 500, 573, 561, 455, 576, 484, 334, 573, 583, 298, 292, 536, 287, 881, 591, 540, 579, 560, 462, 433, 348, 576, 539, 823, 505, 560, 444, 480, 375, 480, 644, 393, 644, 1000, 334, 334, 557, 557, 1000, 334, 484, 614, 1000];
// The same measurement over the bold weights too (titles, skill labels, the name).
const BOLD_WIDTHS = [254, 390, 556, 704, 641, 1000, 834, 278, 447, 447, 500, 704, 329, 379, 329, 472, 702, 500, 627, 625, 650, 600, 648, 567, 677, 648, 384, 384, 704, 704, 704, 549, 967, 759, 760, 723, 834, 722, 672, 808, 914, 451, 596, 817, 686, 1034, 840, 820, 707, 820, 798, 653, 685, 834, 763, 1127, 809, 732, 690, 447, 472, 447, 704, 704, 500, 661, 649, 536, 664, 572, 394, 650, 680, 366, 365, 642, 355, 1016, 690, 636, 663, 650, 534, 518, 417, 686, 613, 934, 588, 670, 526, 500, 388, 500, 704, 438, 704, 1000, 334, 334, 557, 557, 1000, 338, 572, 635, 1000];

// A character outside the table is modelled as a full em: wider than any Latin glyph, so
// an unexpected script makes the estimate longer, never shorter.
const UNKNOWN_WIDTH = 1000;

// Lookup maps built once from the parallel arrays above.
const regularWidth = new Map<string, number>();
// Same, bold.
const boldWidth = new Map<string, number>();
// Filled by walking the table characters by code point (Array.from, so '₹' is one entry).
Array.from(TABLE_CHARS).forEach((ch, i) => {
  // Each character's measured regular width.
  regularWidth.set(ch, REGULAR_WIDTHS[i]!);
  // And its bold width.
  boldWidth.set(ch, BOLD_WIDTHS[i]!);
});

// A placeholder the parser substitutes for a separator span (contact line, project links):
// a '•' with 1.5mm padding each side, which the stylesheet adds and the text does not show.
const SEP = '\u0001';

/** How one block's text is set. Sizes are at step 0; the step scales them. */
interface TextStyle {
  // Font size in pt at fontScale 1.
  readonly size: number;
  // Bold glyphs (wider table).
  readonly bold: boolean;
  // Line-height override (the name's 1.15); otherwise the step's body line-height.
  readonly lineHeight?: number;
  // Extra advance per character in pt (letter-spacing).
  readonly letterSpacing?: number;
  // overflow-wrap:anywhere: a word longer than the line breaks mid-word instead of overflowing.
  readonly breakAnywhere?: boolean;
  // Rendered uppercase by text-transform (section titles).
  readonly uppercase?: boolean;
}

/** One item of the vertical flow: a box of text, or a margin that collapses with its neighbours. */
type FlowItem =
  // Text set at a width; its height depends on the step.
  | { readonly kind: 'text'; readonly text: string; readonly style: TextStyle; readonly indentMm: number; readonly extraPt: number; readonly extraMm: number }
  // The flex entry head: a title and a no-wrap date on one row.
  | { readonly kind: 'head'; readonly title: string; readonly dates: string }
  // A vertical margin in mm at gapScale 1 (scaled by the step), or in em of the body font.
  | { readonly kind: 'margin'; readonly mm: number; readonly bodyEm?: number };

/** Decode the five entities escapeHtml writes, so widths are measured on the printed text. */
function decodeEntities(text: string): string {
  // &amp; last, so "&amp;lt;" decodes to the literal "&lt;" exactly as the browser shows it.
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/** The printed text of an element's inner HTML: separators marked, tags dropped, entities decoded. */
function textOf(inner: string): string {
  // Separator spans first, while their class is still visible.
  const marked = inner.replace(/<span class="resume__(?:contact|link)-sep">[^<]*<\/span>/g, SEP);
  // Then every remaining tag; the text between tags is what prints.
  return decodeEntities(marked.replace(/<[^>]*>/g, ''));
}

/** Width in pt of one run of characters. */
function runWidth(text: string, style: TextStyle, size: number): number {
  // Pick the table once per run.
  const table = style.bold ? boldWidth : regularWidth;
  // Summed per code point.
  let total = 0;
  // Array.from walks code points, so a non-BMP character is one advance, not two.
  for (const ch of Array.from(text)) {
    // A separator is a bullet plus its two 1.5mm paddings.
    if (ch === SEP) total += (table.get('•')! * size) / 1000 + 3 * MM;
    // Everything else from the table, or a full em when unknown.
    else total += ((table.get(ch) ?? UNKNOWN_WIDTH) * size) / 1000 + (style.letterSpacing ?? 0);
  }
  // In pt.
  return total;
}

/**
 * Lines a text occupies at a width: greedy word wrap, breaking at spaces only.
 * Chromium may also break after a hyphen or slash; ignoring those break chances can only
 * add lines, which is the safe direction.
 */
function lineCount(text: string, style: TextStyle, size: number, width: number): number {
  // Uppercase before measuring, exactly as text-transform does before layout.
  const shown = style.uppercase ? text.toUpperCase() : text;
  // Collapsed whitespace, as HTML renders it.
  const words = shown.split(/\s+/).filter((w) => w !== '');
  // An empty block still has no line box, so it costs nothing.
  if (words.length === 0) return 0;
  // One space's advance.
  const space = runWidth(' ', style, size);
  // Lines so far, and the width used on the current one.
  let lines = 1;
  // Width already on the current line.
  let used = 0;
  // Greedy: each word goes on the current line if it fits, else starts a new one.
  for (const word of words) {
    // This word's advance.
    const w = runWidth(word, style, size);
    // First word on a line needs no leading space.
    const need = used === 0 ? w : used + space + w;
    // Fits: extend the line.
    if (need <= width) { used = need; continue; }
    // A word wider than a whole line.
    if (w > width) {
      // overflow-wrap:anywhere splits it across ceil(w / width) lines (a fresh line first if this one is in use).
      if (style.breakAnywhere) { lines += (used === 0 ? 0 : 1) + Math.ceil(w / width) - 1; used = w % width; continue; }
      // Otherwise it overflows sideways on its own line: one line, however long.
      lines += used === 0 ? 0 : 1;
      // The line is full.
      used = width;
      // Next word starts fresh.
      continue;
    }
    // Wrap.
    lines += 1;
    // The word opens the new line.
    used = w;
  }
  // Total lines.
  return lines;
}

// The stylesheet's text styles, at step 0, by element. Changing print-styles.ts means changing these.
const STYLE = {
  // .resume__name: 19pt, line-height 1.15, letter-spacing 0.2pt; h1 is bold by default.
  name: { size: 19, bold: true, lineHeight: 1.15, letterSpacing: 0.2 },
  // body text: 10.5pt.
  body: { size: 10.5, bold: false },
  // .resume__contact: 9.5pt, overflow-wrap:anywhere.
  contact: { size: 9.5, bold: false, breakAnywhere: true },
  // .resume__section-title: 11pt uppercase, letter-spacing 0.8pt; h2 is bold by default.
  sectionTitle: { size: 11, bold: true, letterSpacing: 0.8, uppercase: true },
  // .resume__entry-title: 10.5pt bold.
  entryTitle: { size: 10.5, bold: true },
  // .resume__entry-dates: 9.5pt, white-space nowrap.
  dates: { size: 9.5, bold: false },
  // .resume__entry-subtitle: 10pt italic (italic widths are inside the regular table).
  subtitle: { size: 10, bold: false },
  // .resume__entry-detail: 10pt.
  detail: { size: 10, bold: false },
  // .resume__skill-group: body size, label bold. Modelled all-bold: the wider table covers the label.
  skillGroup: { size: 10.5, bold: true, breakAnywhere: true },
} as const satisfies Record<string, TextStyle>;

/** A text box with no indent and no extra height. */
function text(t: string, style: TextStyle): FlowItem {
  // Most blocks are exactly this.
  return { kind: 'text', text: t, style, indentMm: 0, extraPt: 0, extraMm: 0 };
}

/**
 * The vertical flow of the article markup renderResumeHtml emits, in order.
 * Parses only that markup (its own classes, no nesting of a leaf inside a same-named tag),
 * which is why it can be a scan rather than an HTML parser. An element it does not know is
 * read as body text, so new markup is still counted, never skipped.
 */
export function flowOf(articleHtml: string): readonly FlowItem[] {
  // The flow, in document order.
  const flow: FlowItem[] = [];
  // Every open or close tag, in order.
  const tag = /<(\/?)([a-z0-9]+)((?:\s[^>]*)?)>/gi;
  // Containers currently open, so a close tag knows which margin it ends with.
  const stack: string[] = [];
  // The tag scan.
  let m: RegExpExecArray | null;
  // Walk every tag.
  while ((m = tag.exec(articleHtml)) !== null) {
    // Close tag, tag name, and the attribute text.
    const [, closing, name, attrs] = m;
    // The class, when there is one.
    const cls = /class="([^"]*)"/.exec(attrs ?? '')?.[1] ?? '';
    // A close: emit the container's bottom margin.
    if (closing) {
      // Which container is ending.
      const open = stack.pop();
      // .resume__section: margin-bottom 4mm.
      if (open === 'resume__section') flow.push({ kind: 'margin', mm: 4 });
      // .resume__entry: margin-bottom 2.8mm.
      else if (open === 'resume__entry') flow.push({ kind: 'margin', mm: 2.8 });
      // Everything else closes without a margin.
      continue;
    }
    // Leaves: read the inner HTML up to this element's own close tag and skip past it.
    const closeAt = (): string => {
      // A leaf never nests its own tag name, so the first matching close is its own.
      const end = articleHtml.indexOf(`</${name}>`, tag.lastIndex);
      // Its inner HTML.
      const inner = articleHtml.slice(tag.lastIndex, end);
      // Resume the scan after the close tag.
      tag.lastIndex = end + name!.length + 3;
      // Handed back to the caller.
      return inner;
    };
    // Containers: remember them; the section/entry margins come on close, the list's on open.
    if (cls === 'resume__section' || cls === 'resume__entry' || name === 'article') { stack.push(cls); continue; }
    // .resume__bullets: margin-top 1.2mm, then the items.
    if (cls === 'resume__bullets') { stack.push(cls); flow.push({ kind: 'margin', mm: 1.2 }); continue; }
    // The flex head: title and dates, read together.
    if (cls === 'resume__entry-head') {
      // Its inner HTML holds the h3 and the dates span.
      const inner = closeAt();
      // The title text.
      const title = textOf(/<h3[^>]*>([\s\S]*?)<\/h3>/.exec(inner)?.[1] ?? '');
      // The dates text (may be absent: certifications print no dates row).
      const dates = textOf(/<span class="resume__entry-dates">([\s\S]*?)<\/span>/.exec(inner)?.[1] ?? '');
      // One flow item for the row.
      flow.push({ kind: 'head', title, dates });
      continue;
    }
    // Every remaining element with content is a leaf.
    const inner = closeAt();
    // Its printed text.
    const t = textOf(inner);
    // The name.
    if (cls === 'resume__name') { flow.push(text(t, STYLE.name), { kind: 'margin', mm: 2 }); continue; }
    // The contact line, then its 4mm.
    if (cls === 'resume__contact') { flow.push(text(t, STYLE.contact), { kind: 'margin', mm: 4 }); continue; }
    // A section title: text, 0.8mm padding + 0.5pt rule, then 1.5mm.
    if (cls === 'resume__section-title') { flow.push({ kind: 'text', text: t, style: STYLE.sectionTitle, indentMm: 0, extraPt: 0.5, extraMm: 0.8 }, { kind: 'margin', mm: 1.5 }); continue; }
    // A bullet: indented 4.5mm by the list padding, then 0.8mm.
    if (cls === 'resume__bullet') { flow.push({ kind: 'text', text: t, style: STYLE.body, indentMm: 4.5, extraPt: 0, extraMm: 0 }, { kind: 'margin', mm: 0.8 }); continue; }
    // The italic subtitle line: 0.4mm above.
    if (cls === 'resume__entry-subtitle') { flow.push({ kind: 'margin', mm: 0.4 }, text(t, STYLE.subtitle)); continue; }
    // A grade or description line: 0.6mm above.
    if (cls === 'resume__entry-detail') { flow.push({ kind: 'margin', mm: 0.6 }, text(t, STYLE.detail)); continue; }
    // A skills line, then 1mm.
    if (cls === 'resume__skill-group') { flow.push(text(t, STYLE.skillGroup), { kind: 'margin', mm: 1 }); continue; }
    // The summary is a <p>: the browser's default 1em margins above and below.
    if (name === 'p') { flow.push({ kind: 'margin', mm: 0, bodyEm: 1 }, text(t, STYLE.body), { kind: 'margin', mm: 0, bodyEm: 1 }); continue; }
    // Anything else (the headline, a future element): body text, so it is counted.
    flow.push(text(t, STYLE.body));
  }
  // The whole flow.
  return flow;
}

/** The content height in pt the flow occupies at one step, margins collapsed as CSS does. */
export function flowHeight(flow: readonly FlowItem[], step: TypographyStep): number {
  // Usable width between the @page margins.
  const width = A4_WIDTH_PT - 2 * step.pageMarginMm * MM;
  // Height so far.
  let height = 0;
  // Adjacent positive margins collapse to their maximum; held until the next box.
  let pending = 0;
  // Each item in order.
  for (const item of flow) {
    // A margin joins the pending run.
    if (item.kind === 'margin') {
      // mm scaled by the step's gaps, or em of the body font (the <p> default).
      const v = item.bodyEm !== undefined ? item.bodyEm * STYLE.body.size * step.fontScale : item.mm * MM * step.gapScale;
      // Collapse.
      pending = Math.max(pending, v);
      continue;
    }
    // A box ends the margin run.
    height += pending;
    // Reset for the next run.
    pending = 0;
    // The entry head: the title wraps beside the no-wrap dates.
    if (item.kind === 'head') {
      // Sizes at this step.
      const titleSize = STYLE.entryTitle.size * step.fontScale;
      // Same for the dates.
      const datesSize = STYLE.dates.size * step.fontScale;
      // The dates' width, plus the 4mm flex gap when there are dates.
      const datesWidth = item.dates === '' ? 0 : runWidth(item.dates, STYLE.dates, datesSize) + 4 * MM;
      // Title lines in what is left of the row (at least one line even when empty).
      const titleLines = Math.max(1, lineCount(item.title, STYLE.entryTitle, titleSize, width - datesWidth));
      // The taller of the two columns.
      height += Math.max(titleLines * titleSize * step.lineHeight, datesSize * step.lineHeight);
      continue;
    }
    // A text box at this step.
    const size = item.style.size * step.fontScale;
    // Its line-height (the name keeps its own).
    const lh = item.style.lineHeight ?? step.lineHeight;
    // Lines at its width.
    const lines = lineCount(item.text, item.style, size, width - item.indentMm * MM);
    // Lines × line box, plus any padding and rule (padding scales with the gaps).
    height += lines * size * lh + item.extraPt + item.extraMm * MM * step.gapScale;
  }
  // A trailing margin is counted too: pessimistic by at most a few mm.
  return height + pending;
}

/** Whether a flow fits one A4 page at a step, with the calibrated headroom. */
export function flowFits(flow: readonly FlowItem[], step: TypographyStep): boolean {
  // The page's usable height at this step's margins.
  const pageHeight = A4_HEIGHT_PT - 2 * step.pageMarginMm * MM;
  // Fits only with the headroom left over.
  return flowHeight(flow, step) <= pageHeight * SAFETY;
}

/**
 * The step renderResumeHtml prints at: the widest that fits, else the minimum.
 * Returns an index into TYPOGRAPHY_LADDER. Never throws: a resume that does not fit even
 * at the minimum still RENDERS (at the minimum), because refusing it is the tailor's and
 * the edit gate's job (fitsOnePage), and the worker's PDF page count is the last word.
 */
export function pickStepIndex(flow: readonly FlowItem[]): number {
  // The first rung that fits.
  const index = TYPOGRAPHY_LADDER.findIndex((step) => flowFits(flow, step));
  // None fits: the readable minimum.
  return index === -1 ? TYPOGRAPHY_LADDER.length - 1 : index;
}

/** The extra CSS a step adds after the base stylesheet. Empty at step 0, so step 0 is byte-identical. */
export function stepStylesheet(index: number): string {
  // Step 0 is the base stylesheet itself.
  if (index === 0) return '';
  // The rung's values.
  const s = TYPOGRAPHY_LADDER[index]!;
  // Sizes in pt, two decimals, so the CSS is deterministic text.
  const pt = (base: number): string => `${(base * s.fontScale).toFixed(2)}pt`;
  // Gaps in mm, same.
  const mm = (base: number): string => `${(base * s.gapScale).toFixed(2)}mm`;
  // Every value flowHeight models, overridden from the same rung, so the model and the CSS cannot disagree.
  return `
@page { margin: ${s.pageMarginMm}mm; }
body { font-size: ${pt(10.5)}; line-height: ${s.lineHeight}; }
.resume__name { font-size: ${pt(19)}; margin: 0 0 ${mm(2)} 0; }
.resume__contact { font-size: ${pt(9.5)}; margin: 0 0 ${mm(4)} 0; }
.resume__section { margin: 0 0 ${mm(4)} 0; }
.resume__section-title { font-size: ${pt(11)}; margin: 0 0 ${mm(1.5)} 0; padding-bottom: ${mm(0.8)}; }
.resume__entry { margin: 0 0 ${mm(2.8)} 0; }
.resume__entry-title { font-size: ${pt(10.5)}; }
.resume__entry-subtitle { font-size: ${pt(10)}; margin: ${mm(0.4)} 0 0 0; }
.resume__entry-dates { font-size: ${pt(9.5)}; }
.resume__bullets { margin: ${mm(1.2)} 0 0 0; }
.resume__bullet { margin: 0 0 ${mm(0.8)} 0; }
.resume__skill-group { margin: 0 0 ${mm(1)} 0; }
.resume__entry-detail { font-size: ${pt(10)}; margin: ${mm(0.6)} 0 0 0; }
`;
}

/** The <article> of a rendered document: the part that is laid out on the page. */
export function articleOf(html: string): string {
  // From the article's open tag to its close.
  const start = html.indexOf('<article');
  // Its close tag.
  const end = html.indexOf('</article>');
  // A document without one has nothing to measure; an empty flow would "fit", so throw (fail closed).
  if (start < 0 || end < 0) throw new Error('page-fit: rendered resume has no <article>');
  // Inclusive of both tags, so the scan sees the container open and close.
  return html.slice(start, end + '</article>'.length);
}
