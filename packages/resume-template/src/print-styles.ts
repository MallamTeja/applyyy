/**
 * applyy — the print stylesheet, as an inlined string constant.
 *
 * WHY A STRING AND NOT A .css FILE: the rendered document must be completely
 * self-contained. The worker hands the HTML to Playwright and calls page.pdf();
 * any external stylesheet would be a network fetch that can be slow, blocked on
 * a GitHub Actions runner, or simply absent — producing an unstyled PDF that
 * still "succeeds". Inlining makes that failure mode impossible rather than
 * unlikely. It also keeps the render pure: no filesystem, no fetch (section 7).
 *
 * WHY NO WEB FONTS: @font-face would reintroduce exactly that network fetch, and
 * a font that fails to load changes the page count silently. Only fonts already
 * present on every platform are named.
 *
 * EVERYTHING HERE IS SUBORDINATE TO SECTION 17.2: single column, parser first,
 * eye second. A two-column resume looks better and parses into interleaved
 * gibberish, so the machine never sees the skills and a human never sees the
 * resume. That is the single most common silent fresher killer, so the layout
 * primitives that cause it are avoided on purpose, not merely unused.
 */

/**
 * The stylesheet source, exactly as written in this file.
 *
 * Kept private because its line endings depend on how git checked this file out,
 * and the exported constant below must not. See RESUME_STYLESHEET.
 */
const STYLESHEET_SOURCE = `
/* A4 with symmetric 14mm margins. Playwright honours this only when page.pdf()
   is called with preferCSSPageSize: true; otherwise it silently uses its own
   default Letter size and the bottom of the page is cropped on A4 paper.
   The worker MUST pass that flag -- documented in this package's README. */
@page {
  size: A4;
  margin: 14mm;
}

/* Border-box everywhere so padding can never push an element past the print
   margin and clip its right edge -- the most common way PDF content is lost. */
*, *::before, *::after {
  box-sizing: border-box;
}

/* Zero out the UA margin. The @page margin above is the only one that should
   exist; leaving both would double the effective inset and cost a page. */
body {
  margin: 0;
  /* Websafe stack only, ordered Windows -> macOS -> Linux/CI. Georgia and its
     fallbacks are metrically close, so a page-count difference between Teja's
     preview machine and the Ubuntu Actions runner stays unlikely. */
  font-family: Georgia, 'Times New Roman', 'Liberation Serif', serif;
  /* 10.5pt is the floor most ATS text extractors read reliably; smaller type is
     where extraction quality starts to degrade for scanned or re-encoded PDFs. */
  font-size: 10.5pt;
  /* Comfortable measure for a dense single column without looking airy. */
  line-height: 1.38;
  /* Explicit black on white: never rely on printBackground, which defaults off
     in page.pdf() and would drop any background-based styling entirely. */
  color: #000;
  background: #fff;
}

/* THE SINGLE-COLUMN GUARANTEE, stated as code rather than as a convention.
   A text extractor walks the PDF in content order; multi-column layout makes
   that order interleave two unrelated streams. Anything that could reintroduce
   columns is neutralised here so a future edit has to remove a rule on purpose
   rather than merely add one by habit. */
.resume {
  /* One column, full measure. */
  width: 100%;
  /* Explicitly single-column: overrides any inherited multi-column context. */
  column-count: 1;
  /* Belt and braces -- no float-based side rail can be introduced by accident. */
  float: none;
  /* No absolute positioning: extractors read absolutely-positioned text in DOM
     order, not visual order, which is how "designed" resumes scramble. */
  position: static;
}

/* Name. The only h1 in the document -- parsers weight the first heading as the
   candidate name, so competing h1s actively confuse them. */
.resume__name {
  /* Large enough to read as a name without wasting vertical space. */
  font-size: 19pt;
  /* Tight leading; this is one line and does not need 1.38. */
  line-height: 1.15;
  /* Kill the UA h1 margin so the contact line sits directly beneath. */
  margin: 0 0 2mm 0;
  /* Slight tracking makes a serif name read as a title rather than as body text. */
  letter-spacing: 0.2pt;
}

/* Contact line: email, phone, location and links on one wrapping row.
   Plain inline text separated by a rendered bullet, NOT a flex row of boxes --
   flex children can extract out of order in some engines. */
.resume__contact {
  /* Slightly smaller than body: present but not competing with content. */
  font-size: 9.5pt;
  /* Space before the first section rule. */
  margin: 0 0 4mm 0;
  /* Long link text must wrap rather than overflow the print margin. */
  overflow-wrap: anywhere;
}

/* The separator between contact items. A real character in the markup rather
   than a ::before, because generated content is invisible to text extractors
   and its absence would run 'email' and 'phone' together in the parsed text. */
.resume__contact-sep {
  /* Muted so it reads as punctuation rather than content. */
  color: #444;
  /* Breathing room either side of the bullet. */
  padding: 0 1.5mm;
}

/* Links print as their visible label; the URL is preserved in the href for the
   PDF's link annotation. Underlined so a printed copy still signals a link. */
.resume__contact a {
  color: #000;
  text-decoration: underline;
}

/* Section wrapper. Kept as a block with no page-break rule of its own: forcing
   break-inside: avoid on a long Experience section would push the whole section
   to page two and leave half a page blank. */
.resume__section {
  /* Separates sections without a heavy visual gap. */
  margin: 0 0 4mm 0;
}

/* Section heading, e.g. 'Experience'. Deliberately a plain, conventional word --
   ATS keyword matchers look for standard headings, and a clever heading like
   'What I have shipped' is a heading the parser does not recognise. */
.resume__section-title {
  font-size: 11pt;
  /* Uppercase + tracking gives visual hierarchy without a second font. */
  text-transform: uppercase;
  letter-spacing: 0.8pt;
  margin: 0 0 1.5mm 0;
  /* Hairline rule under the heading: the only decoration in the document, and
     it uses a border rather than a background so printBackground:false is fine. */
  border-bottom: 0.5pt solid #000;
  /* Gap between the text and the rule. */
  padding-bottom: 0.8mm;
  /* A heading stranded at the foot of a page is the classic PDF layout bug. */
  break-after: avoid;
  page-break-after: avoid;
}

/* One role, project or degree. */
.resume__entry {
  /* Space between entries within a section. */
  margin: 0 0 2.8mm 0;
  /* Keep a short entry whole. Applied to the ENTRY, not the section, so a long
     Experience section can still break across pages between two roles. */
  break-inside: avoid;
  page-break-inside: avoid;
}

/* Title row: role/project/degree on the left, dates hard right. Flex is used
   ONLY here, for two single-line siblings that are already in reading order, so
   it cannot scramble extraction the way a flex page layout would. */
.resume__entry-head {
  display: flex;
  /* Push the date to the right margin. */
  justify-content: space-between;
  /* Baseline rather than centre so type of different sizes aligns optically. */
  align-items: baseline;
  /* Guarantees a gap if the title runs long and nearly meets the date. */
  gap: 4mm;
}

/* Role / project name / degree. Bold carries the hierarchy; no colour needed. */
.resume__entry-title {
  font-size: 10.5pt;
  font-weight: 700;
  margin: 0;
  /* Allow the title to shrink before the date does -- the date must stay intact. */
  min-width: 0;
}

/* Employer, institution, or project URL line. */
.resume__entry-subtitle {
  font-size: 10pt;
  /* Italic distinguishes it from the bold title without another font size. */
  font-style: italic;
  margin: 0.4mm 0 0 0;
}

/* Date range. Pre-formatted upstream and printed verbatim -- the renderer does
   no date maths, so output cannot vary with the host timezone or ICU build. */
.resume__entry-dates {
  font-size: 9.5pt;
  /* Never let 'May 2025 - Jul 2025' wrap onto two lines. */
  white-space: nowrap;
  /* Stops flex from compressing the date when the title is long. */
  flex-shrink: 0;
}

/* Bullet list. A real <ul>: extractors emit list items as separate lines, while
   a div-with-a-dash collapses into one run-on paragraph. */
.resume__bullets {
  /* Indent from the left margin, leaving room for the marker. */
  margin: 1.2mm 0 0 0;
  padding-left: 4.5mm;
  /* Standard disc; exotic markers can extract as junk characters or vanish. */
  list-style: disc;
}

/* One achievement line. */
.resume__bullet {
  margin: 0 0 0.8mm 0;
  /* A bullet split across a page boundary is hard to read and often mis-parsed. */
  break-inside: avoid;
  page-break-inside: avoid;
}

/* Skills group row, e.g. 'Languages: TypeScript, Python'. */
.resume__skill-group {
  margin: 0 0 1mm 0;
  /* Long comma lists must wrap inside the margin rather than overflow it. */
  overflow-wrap: anywhere;
}

/* The group label. Bold so the eye can scan categories; still plain text, so the
   extractor reads 'Languages: TypeScript, Python' as one coherent line. */
.resume__skill-label {
  font-weight: 700;
}

/* Education detail line (CGPA, coursework). */
.resume__entry-detail {
  font-size: 10pt;
  margin: 0.6mm 0 0 0;
}
`;

/**
 * The complete stylesheet for a rendered resume, with line endings normalised.
 *
 * WHY THE NORMALISATION — this is a determinism fix, not tidiness. The stylesheet
 * above is a multi-line template literal, so its content includes whatever line
 * endings this FILE has on disk. With git's core.autocrlf=true (set on Teja's
 * machine) a fresh Windows clone checks the file out as CRLF, while the Ubuntu
 * Actions runner gets LF. The rendered HTML would then differ between the
 * approval preview and the submitted PDF, and `tailored_hash` (constraint 8)
 * would differ per platform — silently, with every test passing on each machine
 * in isolation.
 *
 * The package .gitattributes pins LF, which is the real fix. This makes the
 * guarantee hold even if that file is deleted, an archive is unpacked, or a
 * consumer vendors the source — determinism should not depend on a git setting.
 *
 * Exported so the React approval preview can prove it uses the identical CSS
 * rather than an approximation. renderResumeHtml already inlines it; this export
 * is for tooling such as the diff view.
 */
export const RESUME_STYLESHEET = STYLESHEET_SOURCE.replace(/\r\n/g, '\n');
