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
 * 3. SINGLE COLUMN, WITH ONE EXCEPTION. See print-styles.ts. Section 17.2: a
 *    two-column resume parses into interleaved gibberish, so the machine never
 *    sees the skills and a human never sees the resume. The one allowed split is
 *    achievements | certifications in a single flex row (2026-11-08): PROJECT_PLAN.md
 *    ("PREMISE CORRECTED 2026-09-10") and worker/test/ats-parse-real-pdf.test.ts
 *    measured flex and grid as DOM order in Chromium's PDF text layer, so the left
 *    column, first in the DOM, is read whole before the right. `order:` and
 *    row-reverse DO move that layer and stay forbidden.
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
  // The link node, shared by project, certification and achievement link lines.
  MasterLink,
  ResolvedAchievement,
  ResolvedBullet,
  ResolvedCertification,
  ResolvedEducation,
  ResolvedExperience,
  ResolvedProject,
  ResolvedResume,
  ResolvedSkill,
  TailoredSectionKind,
  // By RELATIVE path, not the bare '@applyy/shared-types' (2026-11-07): the Deno tailor now
  // imports this renderer to ask fitsOnePage, and supabase/functions/deno.json has no entry
  // for the bare name. A relative path resolves the same file in Node, Deno and Vite with no
  // import-map change (which, per CLAUDE.md section 3, would need its own canary deploy).
} from '../../shared-types/src/index.ts';

// Escaping is a security boundary: bullet text is downstream of a job
// description, which section 17 classifies as untrusted input.
import { escapeHtml, safeHref } from './escape-html.ts';

// The stylesheet is inlined into the document so the render stays self-contained
// and needs no network — see the reasoning in print-styles.ts.
import { RESUME_STYLESHEET } from './print-styles.ts';

// The one-page model: the article markup is measured, and the widest typography step that fits
// one A4 page is printed (Teja, 2026-11-07: shrink the type before removing content).
import { articleOf, flowFits, flowOf, pickStepIndex, stepStylesheet, TYPOGRAPHY_LADDER } from './page-fit.ts';

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
 * The one reading of a nullable display field: its text, or null for "this resume
 * has none".
 *
 * WHY UNDEFINED IS HANDLED, although the type says `string | null`. The input is a
 * jsonb snapshot, and a writer that left a key out (rather than writing null) gives
 * this function `undefined` behind the type's back — live on 2026-10-24, where a
 * master uploaded without `description` reached the approval queue. Testing only
 * `=== null || === ''` let undefined through to two failures: escapeHtml(undefined)
 * threw, and string concatenation PRINTED the word "undefined" onto the submitted PDF.
 *
 * ONLY nullable fields go through here. A REQUIRED field (label, ref, text, name)
 * that is missing still reaches escapeHtml and fails loudly, because inventing a
 * blank for it would hide a broken snapshot instead of refusing it.
 */
function optionalText(value: string | null | undefined): string | null {
  // Absent, null and empty all mean "none", so all three collapse to one value and
  // the output stays byte-identical whichever shape the writer used (determinism).
  return value === undefined || value === null || value === '' ? null : value;
}

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
  // and folded in only when present; read through optionalText like every nullable.
  const subtitleText = optionalText(subtitle);
  // No subtitle line at all when there is none, never an empty div.
  const subtitleHtml = subtitleText === null
    ? ''
    : `\n<div class="resume__entry-subtitle">${escapeHtml(subtitleText)}</div>`;
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
  const location = optionalText(entry.location);
  // Concatenation is where an unguarded undefined PRINTS rather than throws, so the
  // branch reads the normalised value, never the raw field.
  const subtitle = location === null
    ? entry.company
    : `${entry.company}, ${location}`;
  // data-ref again anchors the entry to its master node for the diff view.
  return `<div class="resume__entry" data-ref="${escapeHtml(entry.ref)}">
${renderEntryHead(entry.role, subtitle, joinDates(entry.start_display, entry.end_display))}
${renderBullets(entry.bullets)}
</div>`;
}

/** Render one project. Every address the project has becomes the subtitle line. */
// One entry's links as a subtitle line: labelled anchors joined by a real
// separator character, or '' when there are none. Extracted from renderProject on
// 2026-11-01 when certifications and achievements gained links, so all three
// sections emit byte-identical link markup - a second copy of the join would be
// free to drift from the one test/ats-parse.test.ts holds.
function renderLinkLine(links: readonly MasterLink[]): string {
  // EVERY link, not one: `links` replaced a single `url` slot precisely because
  // the real resume has a project with both a live deployment and a source
  // repository, and the single slot discarded one of the two on every upload.
  // A loop is therefore the contract's whole point, not a generalisation of it.
  const anchors = links.map(
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
  return anchors.length === 0 ? '' : `\n<div class="resume__entry-subtitle">${subtitle}</div>`;
}

function renderProject(entry: ResolvedProject): string {
  // The project's addresses, via the shared link line (see renderLinkLine).
  const subtitleHtml = renderLinkLine(entry.links);
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
  const field = optionalText(entry.field);
  // Same concatenation hazard as an experience location: read the normalised value.
  const degreeLine = field === null
    ? entry.degree
    : `${entry.degree}, ${field}`;
  // Grade is its own line rather than appended to the subtitle, because
  // recruiters scan for CGPA and a buried one is easy to miss.
  const grade = optionalText(entry.grade_display);
  // No grade line when there is no grade.
  const gradeHtml = grade === null
    ? ''
    : `\n<div class="resume__entry-detail">${escapeHtml(grade)}</div>`;
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
  // ONE LINK = A LINKED TITLE (Teja, 2026-11-12: "compress this, create more space"). A
  // single credential or profile link used to print its own line ("Machine Learning
  // credential") under the title, and with >= 5 certs on every resume those lines were the
  // tallest part of the split row. The title itself now carries the href and prints blue,
  // so the line is gone and the URL still reaches the PDF link annotation. Two or more
  // links keep the separate link line: one title cannot be two anchors.
  const links = entry.links ?? [];
  // The lone link, or undefined when there are zero or several.
  const single = links.length === 1 ? links[0] : undefined;
  // The label text, escaped once here, wrapped in its anchor when there is exactly one link.
  const titleHtml = single === undefined
    ? escapeHtml(entry.label)
    : `<a href="${safeHref(single.url)}">${escapeHtml(entry.label)}</a>`;
  const head = `<div class="resume__entry-head">
<h3 class="resume__entry-title">${titleHtml}</h3>
</div>`;
  // `description` follows renderEducation's grade_display pattern exactly: its
  // own detail line when present, and NOTHING at all when null or empty.
  // Appending it to the label instead would print 'AWS Certified Practitioner – '
  // with a dangling separator on every entry that has no description, and the
  // contract says null is the normal case rather than the exception.
  const description = optionalText(entry.description);
  // The live 2026-10-24 crash site: an absent description now means "none".
  const descriptionHtml = description === null
    ? ''
    : `\n<div class="resume__entry-detail">${escapeHtml(description)}</div>`;
  // Credential / profile links (2026-11-01), after the detail line so the name
  // and issuer read first. `?? []` IS THE CONTROL: every resume frozen into
  // applications.tailored_profile before this date has no `links` key here, and
  // the approval queue renders those snapshots - `.map` on the raw field would
  // repeat the 2026-10-24 crash in a new field. Absent and [] print nothing.
  // A single link already rides on the title above, so only 2+ links print a line here.
  const linksHtml = single === undefined ? renderLinkLine(links) : '';
  // data-ref anchors the entry to its master node so the approval diff view can
  // highlight this exact line, the same as every other entry kind. It is an
  // attribute, so a text extractor never sees it on the PDF.
  return `<div class="resume__entry" data-ref="${escapeHtml(entry.ref)}">
${head}${descriptionHtml}${linksHtml}
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
  // RUN-IN (Teja, 2026-11-12: "compress this, create more space for resumes tailored from
  // now"): an achievement with no description and exactly one bullet prints as ONE line,
  // "Label: bullet text", instead of a bold title line plus a bulleted line. In the half-width
  // split column that cut Teja's three achievements from 213.9pt to ~140pt (page-fit model),
  // room the fit ladder used to buy by trimming a real experience bullet (row 7dac59a5,
  // bullet_aczen_fintech). Any other shape (a description, 0 or 2+ bullets, 2+ links)
  // keeps the full layout, because a run-in line has room for one sentence only.
  const bullet = entry.bullets.length === 1 ? entry.bullets[0] : undefined;
  // The links, `?? []` for snapshots frozen before links existed (see renderUndatedEntry).
  const links = entry.links ?? [];
  // Not a run-in shape: render the ordinary two-part entry.
  if (bullet === undefined || optionalText(entry.description) !== null || links.length > 1) {
    return renderUndatedEntry(entry);
  }
  // The label, linked when it has its one profile link (same rule as renderUndatedEntry).
  const label = links.length === 1
    ? `<a href="${safeHref(links[0]!.url)}">${escapeHtml(entry.label)}</a>`
    : escapeHtml(entry.label);
  // A div, not a <p>: page-fit reads every <p> as the summary. The label is bold inline
  // text and the colon is a real character, so an extractor reads "Label: text" as one
  // line (inline elements never break). The bullet keeps its data-ref for the diff view.
  return `<div class="resume__entry" data-ref="${escapeHtml(entry.ref)}">
<div class="resume__runin"><strong class="resume__runin-label">${label}</strong>: <span data-ref="${escapeHtml(bullet.ref)}">${escapeHtml(bullet.text)}</span></div>
</div>`;
}

/** Render one certification. Same shape and same seam reasoning as renderAchievement. */
function renderCertification(entry: ResolvedCertification): string {
  // CERT INLINE (2026-11-10, row 38bb2f12): the issuer goes on the title line as
  // "Name (Issuer)" instead of its own detail line. Teja's rule keeps >= 5 certs on
  // every resume, so the second line per cert made the certifications column the
  // tallest half of the split and pushed floor-trimmed resumes past one page
  // (measured: column 157.6pt -> 113.9pt, the refused v30 shape 791.0pt -> 767.7pt
  // against a 778.1pt budget). A cert's description is a short issuing body, which
  // reads naturally in parentheses; achievements keep the two-line layout because
  // theirs is a phrase.
  const issuer = optionalText(entry.description);
  // No issuer: render untouched. Appending would print "Name ()", the dangling
  // separator renderUndatedEntry's own comment warns against.
  if (issuer === null) return renderUndatedEntry(entry);
  // The label carries the issuer, and the description is cleared so the detail line
  // is not printed twice. The label is still escaped once, inside renderUndatedEntry.
  return renderUndatedEntry({ ...entry, label: `${entry.label} (${issuer})`, description: null });
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
    case 'summary': {
      // Summary is prose and cannot be ref-constrained the way a bullet can —
      // aa flagged it as the weakest point in the honesty model, and section
      // 18.8 is why the Auditor gates it. Rendering it verbatim is correct; the
      // defence belongs upstream, not here.
      // Read once through optionalText so an absent summary key means "no summary".
      const summary = optionalText(resume.summary);
      // An empty body makes wrapSection drop the heading too.
      return wrapSection(kind, summary === null
        ? ''
        : `<p class="resume__summary">${escapeHtml(summary)}</p>`);
    }
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
  // The scheme goes INSIDE safeHref's argument (fixed 2026-11-08): safeHref allow-lists
  // by prefix, so a bare address failed the check and every resume shipped
  // href="mailto:#", a dead link. Passing the whole URL keeps the allow-list and the
  // escaping (a quote in the address still becomes &quot;) in the one shared gate.
  parts.push(`<a href="${safeHref(`mailto:${identity.email}`)}">${escapeHtml(identity.email)}</a>`);
  // Phone and location are nullable; push only when genuinely present.
  const phone = optionalText(identity.phone);
  // Pushed only when present, so an absent phone leaves no separator behind.
  if (phone !== null) parts.push(escapeHtml(phone));
  // Same rule for the location line.
  const location = optionalText(identity.location);
  // Pushed only when present.
  if (location !== null) parts.push(escapeHtml(location));
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
  // THE ONE SIDE-BY-SIDE PAIR (Teja, 2026-11-08): achievements LEFT, certifications
  // RIGHT. Both are short undated lists, so a full-width section each wastes half the
  // line and pushes a resume onto page two. Rendered once here, through the ordinary
  // switch, so the wrapped sections are byte-identical to how each prints alone.
  const achievementsHtml = renderSection('achievements', resume);
  // The right column, rendered the same way.
  const certificationsHtml = renderSection('certifications', resume);
  // Where the pair goes: the slot of whichever of the two the tailoring listed FIRST.
  // -1 when neither is listed, which the guard below also covers.
  const firstSplitIndex = resume.section_order.findIndex(
    // Either kind claims the slot; the other kind's own slot then prints nothing.
    (kind) => kind === 'achievements' || kind === 'certifications',
  );
  // Split ONLY when the tailoring asked for both AND both rendered something. One kind
  // alone, or one with no entries, prints exactly as before: a half-empty two-column
  // box would read as a missing section.
  const split = resume.section_order.includes('achievements')
    // Both kinds listed...
    && resume.section_order.includes('certifications')
    // ...and both non-empty (wrapSection returns '' for an empty list).
    && achievementsHtml !== ''
    // The right column needs content too.
    && certificationsHtml !== '';
  // Sections render in the order the tailoring decided — order is data, never
  // recovered by sorting here.
  const sections = resume.section_order
    .map((kind, index) => {
      // Any kind outside the pair, or no split at all: the ordinary path.
      if (!split || (kind !== 'achievements' && kind !== 'certifications')) return renderSection(kind, resume);
      // The pair's second slot (and any duplicate) prints nothing; the filter drops it.
      if (index !== firstSplitIndex) return '';
      // ACHIEVEMENTS FIRST IN THE DOM, ALWAYS, whichever kind claimed the slot: a row
      // flex box paints in DOM order, and Chromium's PDF text layer follows paint order
      // (measured 2026-09-10, worker/test/ats-parse-real-pdf.test.ts), so a parser reads
      // the whole left column before the right one. Never swap them with CSS `order:`.
      return `<div class="resume__split">\n${achievementsHtml}\n${certificationsHtml}\n</div>`;
    })
    // Drop sections that rendered empty so no bare heading survives.
    .filter((html) => html !== '')
    .join('\n');
  // Optional headline sits under the name, e.g. 'Backend Engineer'.
  const headlineText = optionalText(resume.identity.headline);
  // No headline div at all when there is none.
  const headline = headlineText === null
    ? ''
    : `\n<div class="resume__headline">${escapeHtml(headlineText)}</div>`;
  // A full document, not a fragment: page.pdf() needs <html> and the inlined
  // <style>, and the React preview gets the identical bytes via iframe srcdoc.
  // lang="en" helps PDF text extraction pick the right word-breaking rules.
  // The article on its own first, because it is what the page-fit model measures: the same
  // markup prints at every step; only the CSS differs.
  const article = `<article class="resume">
<h1 class="resume__name">${escapeHtml(resume.identity.full_name)}</h1>${headline}
${renderContact(resume.identity)}
${sections}
</article>`;
  // The widest step at which the article fits one page (the readable minimum when none does).
  // Step 0 adds nothing, so a resume that already fits is byte-identical to before.
  // No CRLF normalisation needed: the model splits text on \s+, which swallows a stray \r.
  const stepCss = stepStylesheet(pickStepIndex(flowOf(article)));
  const document = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(resume.identity.full_name)} — Resume</title>
<style>${RESUME_STYLESHEET}${stepCss}</style>
</head>
<body>
${article}
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

/**
 * THE ONE-PAGE QUESTION, for the tailor's trimmer and the web edit gate: does this resume fit
 * one A4 page at the readable minimum typography (the last rung of TYPOGRAPHY_LADDER)?
 * True: renderResumeHtml prints it on one page, at the widest step that fits.
 * False: content must go; refuse the edit, or trim.
 * Fails CLOSED: a resume this renderer refuses (a stale schema_version) answers false,
 * because unmeasurable is not "fits" (CLAUDE.md section 6).
 */
export function fitsOnePage(resume: ResolvedResume): boolean {
  // The printed document, or nothing to measure.
  let html: string;
  // The renderer's own refusal is caught, never passed through as a fit.
  try { html = renderResumeHtml(resume); } catch { return false; }
  // Measured at the minimum rung, the last one the renderer can fall back to.
  return flowFits(flowOf(articleOf(html)), TYPOGRAPHY_LADDER[TYPOGRAPHY_LADDER.length - 1]!);
}
