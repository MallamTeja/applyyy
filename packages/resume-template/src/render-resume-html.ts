/**
 * applyy — the one HTML resume renderer.
 *
 * React imports this to draw the approval preview Teja looks at; the Playwright
 * worker imports the SAME function and feeds its output to page.pdf(). That
 * shared import is what makes "what you approved is byte-for-byte what gets
 * sent" a property of the code rather than a promise (PROJECT_PLAN section 7).
 *
 * THREE PROPERTIES THIS FILE MUST NEVER LOSE:
 *
 * 1. PURE. No fetch, no filesystem, no environment, no globals. The function's
 *    output depends on its argument and nothing else.
 * 2. DETERMINISTIC. No Date, no Intl, no Math.random, no sort. Identical input
 *    must produce a byte-identical string on Teja's Windows machine and on the
 *    Ubuntu Actions runner. Both the approval guarantee and the `tailored_hash`
 *    cache key (constraint 8) collapse if this slips — a hash that varies by
 *    host silently defeats the cache, and one that varies by run means the
 *    approved preview and the submitted PDF are not provably the same document.
 * 3. SINGLE COLUMN. See print-styles.ts. Section 17.2: a two-column resume
 *    parses into interleaved gibberish, so the machine never sees the skills and
 *    a human never sees the resume.
 *
 * WHAT IT DELIBERATELY CANNOT DO: it takes a ResolvedResume, which carries no
 * master profile and no raw dates. It therefore cannot resolve a node ref even
 * by accident, and cannot format a date. Both capabilities were removed from the
 * type rather than merely avoided in the code.
 */

// The render input and its parts. Imported from the schema owner, never
// re-declared here: per section 10 the ref-into-master shape IS the
// anti-fabrication defence, and a second definition of it would be the drift
// that defence cannot survive.
import type {
  ResolvedAchievement,
  ResolvedBullet,
  ResolvedCertification,
  ResolvedEducation,
  ResolvedExperience,
  ResolvedProject,
  ResolvedResume,
  ResolvedSkill,
  TailoredSectionKind,
} from '@applyy/shared-types';

// Escaping is a security boundary: bullet text is downstream of a job
// description, which section 17 classifies as untrusted input.
import { escapeHtml, safeHref } from './escape-html.ts';

// The stylesheet is inlined into the document so the render stays self-contained
// and needs no network — see the reasoning in print-styles.ts.
import { RESUME_STYLESHEET } from './print-styles.ts';

/**
 * Thrown when a resume cannot be rendered honestly.
 *
 * A distinct error type so callers can tell a contract violation apart from a
 * genuine bug: the worker must fail the application loudly rather than submit a
 * malformed or half-rendered PDF.
 */
export class ResumeRenderError extends Error {
  // Named for `instanceof` checks that survive minification in the Vite bundle.
  override readonly name = 'ResumeRenderError';
}

/** The schema version this renderer understands. Bumped in lockstep with shared-types. */
const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * Conventional, boring section headings — on purpose.
 *
 * ATS keyword matchers look for standard headings; a clever heading like "What I
 * have shipped" is a heading the parser does not recognise, so the content under
 * it is filed as unclassified prose. Section 17.2 again: parser first, eye second.
 */
const SECTION_HEADINGS: Readonly<Record<TailoredSectionKind, string>> = {
  // No heading rule of its own; the summary sits directly under the contact line.
  summary: 'Summary',
  skills: 'Skills',
  experience: 'Experience',
  projects: 'Projects',
  education: 'Education',
  // 'Achievements' and 'Certifications' are the plain dictionary words, chosen
  // for the same reason as the five above rather than by analogy with them: an
  // ATS keyword-matches the SECTION on its heading, so 'Awards & Recognition'
  // or 'Credentials' would file every line beneath it as unclassified prose.
  // They are also the words the master types are named after, so a reader never
  // has to hold a translation between the contract and the printed page.
  achievements: 'Achievements',
  certifications: 'Certifications',
};

/**
 * Render one achievement line.
 *
 * `master_text` is deliberately NOT rendered: it exists on the type for the
 * approval diff view only, and printing it would put the pre-tailoring wording
 * on the submitted PDF.
 */
function renderBullet(bullet: ResolvedBullet): string {
  // data-ref carries the master node id into the DOM so the diff view and the
  // Auditor UI can highlight a specific line without re-deriving the mapping.
  // It is an HTML attribute, so a text extractor never sees it on the PDF.
  return `<li class="resume__bullet" data-ref="${escapeHtml(bullet.ref)}">${escapeHtml(bullet.text)}</li>`;
}

/**
 * Render a bullet list, or nothing at all when there are none.
 *
 * Returning '' rather than an empty <ul> matters: an empty list still occupies
 * vertical space and some extractors emit a stray bullet character for it.
 */
function renderBullets(bullets: readonly ResolvedBullet[]): string {
  // Guard before building markup so the empty case cannot produce <ul></ul>.
  if (bullets.length === 0) return '';
  // Newline-joined for a stable, diffable string; whitespace between list items
  // is not rendered, so this costs nothing visually.
  const items = bullets.map(renderBullet).join('\n');
  return `<ul class="resume__bullets">\n${items}\n</ul>`;
}

/**
 * The two-line heading shared by experience, project and education entries.
 *
 * Extracted because all three need identical markup: divergence here is how one
 * section starts parsing differently from its neighbours.
 */
function renderEntryHead(title: string, subtitle: string | null, dates: string): string {
  // Subtitle is optional across all three entry kinds, so it is built separately
  // and folded in only when present.
  const subtitleHtml = subtitle === null || subtitle === ''
    ? ''
    : `\n<div class="resume__entry-subtitle">${escapeHtml(subtitle)}</div>`;
  // Dates are printed VERBATIM from the *_display fields. The renderer performs
  // no date arithmetic and no formatting, which is what keeps output independent
  // of host timezone and ICU version.
  return `<div class="resume__entry-head">
<h3 class="resume__entry-title">${escapeHtml(title)}</h3>
<span class="resume__entry-dates">${escapeHtml(dates)}</span>
</div>${subtitleHtml}`;
}

/**
 * Join a date range for display.
 *
 * Pure string concatenation of two already-formatted values — 'Present' arrives
 * as an end_display value from upstream and is never computed here.
 */
function joinDates(start: string, end: string): string {
  // An entry with no end value must not print a dangling separator.
  if (end === '') return start;
  // An en dash reads correctly and extracts as a normal character.
  return `${start} – ${end}`;
}

/** Render one role. Company and location form the subtitle line. */
function renderExperience(entry: ResolvedExperience): string {
  // Location is nullable; when absent the subtitle is the company alone rather
  // than 'Company, ' with a trailing comma.
  const subtitle = entry.location === null || entry.location === ''
    ? entry.company
    : `${entry.company}, ${entry.location}`;
  // data-ref again anchors the entry to its master node for the diff view.
  return `<div class="resume__entry" data-ref="${escapeHtml(entry.ref)}">
${renderEntryHead(entry.role, subtitle, joinDates(entry.start_display, entry.end_display))}
${renderBullets(entry.bullets)}
</div>`;
}

/** Render one project. Every address the project has becomes the subtitle line. */
function renderProject(entry: ResolvedProject): string {
  // EVERY link, not one: `links` replaced a single `url` slot precisely because
  // the real resume has a project with both a live deployment and a source
  // repository, and the single slot discarded one of the two on every upload.
  // A loop is therefore the contract's whole point, not a generalisation of it.
  const anchors = entry.links.map(
    // The LABEL is the anchor text and the URL stays in the href. Three raw URLs
    // side by side is a line no recruiter reads and no parser gains from, and
    // `MasterLink` carries a label ('Live', 'Source') exactly so it can be the
    // visible text; the PDF still gets a clickable link annotation from the href.
    // safeHref on every href with no exceptions — it collapses anything that is
    // not http(s)/mailto to '#', which is what stops a javascript: URL firing in
    // the React approval preview, the one place a human deliberately clicks a
    // link in a document derived from untrusted input.
    (link) => `<a href="${safeHref(link.url)}">${escapeHtml(link.label)}</a>`,
  );
  // The separator is a REAL CHARACTER IN THE MARKUP, for the same reason
  // renderContact spells out: CSS generated content (a ::before, a ::after, a
  // border) is INVISIBLE to a text extractor, so 'Live' and 'Source' would be
  // concatenated into the single token 'LiveSource' in the parsed text and
  // neither word would match anything. This is a correctness choice about what
  // a machine reads, not a visual preference — test/ats-parse.test.ts is what
  // holds it. join() also means a one-link project emits no separator at all,
  // rather than a trailing bullet with nothing after it.
  const subtitle = anchors.join('<span class="resume__link-sep">•</span>');
  // Built by hand rather than through renderEntryHead because the subtitle here
  // is markup, and renderEntryHead escapes its subtitle as plain text.
  // Keyed on the ANCHOR COUNT rather than on `subtitle === ''`: a project with
  // no public address must print no subtitle div whatsoever, and an empty div
  // still occupies vertical space. A link whose label happens to be empty is a
  // different fact — it still has an address worth carrying into the PDF.
  const subtitleHtml = anchors.length === 0 ? '' : `\n<div class="resume__entry-subtitle">${subtitle}</div>`;
  return `<div class="resume__entry" data-ref="${escapeHtml(entry.ref)}">
<div class="resume__entry-head">
<h3 class="resume__entry-title">${escapeHtml(entry.name)}</h3>
<span class="resume__entry-dates">${escapeHtml(joinDates(entry.start_display, entry.end_display))}</span>
</div>${subtitleHtml}
${renderBullets(entry.bullets)}
</div>`;
}

/** Render one degree. Grade and field of study are both optional. */
function renderEducation(entry: ResolvedEducation): string {
  // Field of study qualifies the degree when present, e.g. 'B.Tech, CSE'.
  const degreeLine = entry.field === null || entry.field === ''
    ? entry.degree
    : `${entry.degree}, ${entry.field}`;
  // Grade is its own line rather than appended to the subtitle, because
  // recruiters scan for CGPA and a buried one is easy to miss.
  const gradeHtml = entry.grade_display === null || entry.grade_display === ''
    ? ''
    : `\n<div class="resume__entry-detail">${escapeHtml(entry.grade_display)}</div>`;
  return `<div class="resume__entry" data-ref="${escapeHtml(entry.ref)}">
${renderEntryHead(degreeLine, entry.institution, joinDates(entry.start_display, entry.end_display))}${gradeHtml}
${renderBullets(entry.bullets)}
</div>`;
}

/**
 * The shared body of an UNDATED entry — an achievement or a certification.
 *
 * ONE implementation because the two must not drift. renderEntryHead was
 * extracted for the same reason: divergence in entry markup is how one section
 * starts parsing differently from its neighbours, and a parser reading two
 * shapes for two adjacent lists is the failure this package exists to avoid.
 *
 * The union parameter is honest about today's contract rather than clever.
 * shared-types keeps ResolvedAchievement and ResolvedCertification as separate
 * interfaces — not an alias — so a future divergence arrives as an ADDED FIELD
 * rather than a breaking rename. On the day one of them grows a field, this
 * union stops being sufficient and the two named wrappers below take over; that
 * is why they exist as wrappers instead of the switch calling this directly.
 */
function renderUndatedEntry(entry: ResolvedAchievement | ResolvedCertification): string {
  // NO DATES ROW, and deliberately not an empty `<span class="resume__entry-dates">`
  // standing in for one. The contract carries no date for these because the real
  // document writes them undated, so printing an empty slot would be the renderer
  // asserting the existence of a field the type refused to have — and the DATE
  // CONTRACT says a rendered date must be decided upstream and printed verbatim,
  // which a field with no upstream source cannot satisfy.
  //
  // The resume__entry-head wrapper is kept even with a single child so the class
  // structure is identical to experience, projects and education: a stylesheet
  // rule or a diff-view selector written against one entry kind then holds for
  // all five.
  const head = `<div class="resume__entry-head">
<h3 class="resume__entry-title">${escapeHtml(entry.label)}</h3>
</div>`;
  // `description` follows renderEducation's grade_display pattern exactly: its
  // own detail line when present, and NOTHING at all when null or empty.
  // Appending it to the label instead would print 'AWS Certified Practitioner – '
  // with a dangling separator on every entry that has no description, and the
  // contract says null is the normal case rather than the exception.
  const descriptionHtml = entry.description === null || entry.description === ''
    ? ''
    : `\n<div class="resume__entry-detail">${escapeHtml(entry.description)}</div>`;
  // data-ref anchors the entry to its master node so the approval diff view can
  // highlight this exact line, the same as every other entry kind. It is an
  // attribute, so a text extractor never sees it on the PDF.
  return `<div class="resume__entry" data-ref="${escapeHtml(entry.ref)}">
${head}${descriptionHtml}
${renderBullets(entry.bullets)}
</div>`;
}

/**
 * Render one achievement — a hackathon placing, a ranking, a scholarship.
 *
 * A named wrapper rather than calling renderUndatedEntry from the switch: this
 * is the seam where achievements and certifications are allowed to diverge, and
 * a seam that does not exist yet is a seam nobody adds under pressure later.
 */
function renderAchievement(entry: ResolvedAchievement): string {
  return renderUndatedEntry(entry);
}

/** Render one certification. Same shape and same seam reasoning as renderAchievement. */
function renderCertification(entry: ResolvedCertification): string {
  return renderUndatedEntry(entry);
}

/**
 * Render the skills section, grouped by category.
 *
 * Grouping uses a Map, whose iteration order is insertion order — so groups
 * appear in the order their first skill appears in the resolved array. That is a
 * DETERMINISTIC ordering derived from the data, not a sort. Sorting would make
 * two genuinely different tailorings render identically and collide on
 * `tailored_hash`, silently serving the wrong cached PDF (constraint 8).
 */
function renderSkills(skills: readonly ResolvedSkill[]): string {
  // Map rather than a plain object: object keys that look like integers get
  // reordered by the JS engine, which would be a silent determinism bug for a
  // category named e.g. '2024'.
  const groups = new Map<string, string[]>();
  // One pass, preserving first-appearance order for both groups and members.
  for (const skill of skills) {
    // Look up before inserting so an existing group is appended to, not replaced.
    const existing = groups.get(skill.category);
    if (existing === undefined) {
      // First skill in this category defines where the group appears.
      groups.set(skill.category, [skill.name]);
    } else {
      // Subsequent skills keep their relative order within the group.
      existing.push(skill.name);
    }
  }
  // Render each group as one plain text line: 'Languages: TypeScript, Python'.
  // A single flowing line is what an extractor reads cleanly; a nested list or a
  // table would fragment the same information across rows.
  const rows: string[] = [];
  for (const [category, names] of groups) {
    // Comma-separated is the convention every ATS keyword matcher expects.
    rows.push(
      `<div class="resume__skill-group"><span class="resume__skill-label">${escapeHtml(category)}:</span> ${escapeHtml(names.join(', '))}</div>`,
    );
  }
  return rows.join('\n');
}

/** Wrap rendered section content in its heading, or return '' if there is none. */
function wrapSection(kind: TailoredSectionKind, body: string): string {
  // An empty section would print a heading with a rule and nothing under it,
  // which reads as a mistake on a resume and adds a keyword the content does
  // not support.
  if (body === '') return '';
  // The heading text comes from the fixed table above, never from input.
  return `<section class="resume__section" data-section="${kind}">
<h2 class="resume__section-title">${escapeHtml(SECTION_HEADINGS[kind])}</h2>
${body}
</section>`;
}

/**
 * Render whichever section `kind` names.
 *
 * The switch is exhaustive over TailoredSectionKind and ends in a `never` check,
 * so adding a section kind to shared-types becomes a COMPILE error here rather
 * than a section that silently fails to render on every resume.
 */
function renderSection(kind: TailoredSectionKind, resume: ResolvedResume): string {
  switch (kind) {
    case 'summary':
      // Summary is prose and cannot be ref-constrained the way a bullet can —
      // aa flagged it as the weakest point in the honesty model, and section
      // 18.8 is why the Auditor gates it. Rendering it verbatim is correct; the
      // defence belongs upstream, not here.
      return wrapSection(kind, resume.summary === null || resume.summary === ''
        ? ''
        : `<p class="resume__summary">${escapeHtml(resume.summary)}</p>`);
    case 'skills':
      return wrapSection(kind, renderSkills(resume.skills));
    case 'experience':
      return wrapSection(kind, resume.experience.map(renderExperience).join('\n'));
    case 'projects':
      return wrapSection(kind, resume.projects.map(renderProject).join('\n'));
    case 'education':
      return wrapSection(kind, resume.education.map(renderEducation).join('\n'));
    case 'achievements':
      // A real rendering, not a placeholder. These two cases are why the `never`
      // below is worth its weight: the contract grew two section kinds, and the
      // compiler refused to build until each one had somewhere to print. A cast
      // or a `default: return ''` would have bought a green build by turning the
      // silent drop this change exists to fix back into a silent drop.
      return wrapSection(kind, resume.achievements.map(renderAchievement).join('\n'));
    case 'certifications':
      return wrapSection(kind, resume.certifications.map(renderCertification).join('\n'));
    default: {
      // Unreachable while the switch is exhaustive; the assignment is what makes
      // tsc prove that for us on every build.
      const unreachable: never = kind;
      throw new ResumeRenderError(`Unknown resume section kind: ${String(unreachable)}`);
    }
  }
}

/** Render the contact line: email, phone, location and links, separated by bullets. */
function renderContact(identity: ResolvedResume['identity']): string {
  // Collected as markup fragments so absent optional fields leave no separator.
  const parts: string[] = [];
  // Email first — it is the field an ATS most needs to extract.
  parts.push(`<a href="mailto:${safeHref(identity.email)}">${escapeHtml(identity.email)}</a>`);
  // Phone and location are nullable; push only when genuinely present.
  if (identity.phone !== null && identity.phone !== '') parts.push(escapeHtml(identity.phone));
  if (identity.location !== null && identity.location !== '') parts.push(escapeHtml(identity.location));
  // Links render as their label, in the order the master declares them.
  for (const link of identity.links) {
    parts.push(`<a href="${safeHref(link.url)}">${escapeHtml(link.label)}</a>`);
  }
  // The separator is a REAL character in the markup, not CSS generated content:
  // generated content is invisible to text extractors, so without it the parsed
  // text would run 'email' and 'phone' together into one token.
  const separator = '<span class="resume__contact-sep">•</span>';
  return `<div class="resume__contact">${parts.join(separator)}</div>`;
}

/**
 * Render a resolved resume to a complete, self-contained HTML document.
 *
 * The worker passes the result to Playwright via page.setContent() and then
 * page.pdf({ preferCSSPageSize: true }); React shows the identical string in an
 * iframe srcdoc so the preview and the PDF are the same bytes, not two renders
 * that are believed to agree.
 *
 * @throws ResumeRenderError when the snapshot's schema version is one this
 *         renderer does not understand — a stale pinned resume must fail loudly
 *         rather than render with fields silently missing.
 */
export function renderResumeHtml(resume: ResolvedResume): string {
  // Version gate first: everything below assumes this shape. A snapshot frozen
  // under an older schema is exactly the case resume pinning creates, so it is
  // checked rather than assumed.
  if (resume.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    throw new ResumeRenderError(
      `Unsupported resume schema_version ${String(resume.schema_version)}; this renderer supports ${SUPPORTED_SCHEMA_VERSION}.`,
    );
  }
  // Sections render in the order the tailoring decided — order is data, never
  // recovered by sorting here.
  const sections = resume.section_order
    .map((kind) => renderSection(kind, resume))
    // Drop sections that rendered empty so no bare heading survives.
    .filter((html) => html !== '')
    .join('\n');
  // Optional headline sits under the name, e.g. 'Backend Engineer'.
  const headline = resume.identity.headline === null || resume.identity.headline === ''
    ? ''
    : `\n<div class="resume__headline">${escapeHtml(resume.identity.headline)}</div>`;
  // A full document, not a fragment: page.pdf() needs <html> and the inlined
  // <style>, and the React preview gets the identical bytes via iframe srcdoc.
  // lang="en" helps PDF text extraction pick the right word-breaking rules.
  const document = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(resume.identity.full_name)} — Resume</title>
<style>${RESUME_STYLESHEET}</style>
</head>
<body>
<article class="resume">
<h1 class="resume__name">${escapeHtml(resume.identity.full_name)}</h1>${headline}
${renderContact(resume.identity)}
${sections}
</article>
</body>
</html>
`;
  // THE SINGLE LINE-ENDING CHOKE POINT. Every string above is built from
  // multi-line template literals, so the output inherits whatever line endings
  // THIS SOURCE FILE has on disk. git's core.autocrlf=true (set on Teja's
  // machine, and the default on Windows) checks a fresh clone out as CRLF while
  // the Ubuntu Actions runner gets LF — so the approval preview and the
  // submitted PDF would differ, and `tailored_hash` (constraint 8) would vary by
  // platform, with every test still passing on each machine in isolation.
  //
  // The package .gitattributes pins LF and is the real fix; normalising here
  // means the byte-for-byte guarantee does not depend on a git setting, an
  // archive extraction, or a consumer vendoring the source.
  return document.replace(/\r\n/g, '\n');
}
