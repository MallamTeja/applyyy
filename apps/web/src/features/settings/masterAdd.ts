/* Adding one new node to the master profile from the Master Profile page's "+ Add" forms.
 *
 * WHY A NEW VERSION, NOT AN EDIT. Master versions are immutable (masterStore.ts): an
 * application pins the version it was tailored against, so an add must land as version
 * N+1 built on the NEWEST stored master. Building on the copy the page loaded at mount
 * would silently drop anything stored since, such as a skill attested on the approval page.
 *
 * WHY THE PURE HALF IS SPLIT FROM THE SAVE. Same split as masterStore.ts and attestSkill.ts:
 * `addToMaster` decides what the next master IS and is the part with the bugs in it, so it is
 * pure and tested; `saveMasterAddition` is the read-then-insert around it. */

// The one client type the two masterStore calls take, so this file cannot drift from them.
import type { SupabaseClient } from '@supabase/supabase-js';

// The node shapes; types only, from the app's single contract seam.
import type { MasterBullet, MasterProfile } from '../../data/contract';
// The http(s) allowlist every stored URL already renders through; reused as the write-side gate.
import { safeHref } from '../../app/safeHref.ts';
// The ingest gate: fills explicit nulls and refuses duplicate ids or a malformed profile.
import { checkMasterProfile } from './masterIngest';
// The newest-version read, the insert-only writer and their refusal wording; reused, never re-implemented.
import { loadCurrentMasterProfile, storeMasterProfile, storeRefusalMessage } from './masterStore';

/* Every kind of node the page can add. A closed union, so a section added later is a compile
   error in ADD_FIELDS and in addToMaster's switch, not a form that silently saves nothing. */
export type AddKind =
  // A link under identity (portfolio, GitHub, LinkedIn).
  | 'link'
  // The summary paragraph, only when the master has none.
  | 'summary'
  // One skill with its resume group.
  | 'skill'
  // One job with its bullets.
  | 'experience'
  // One project with its links and bullets.
  | 'project'
  // One qualification with its bullets.
  | 'education'
  // One certification line.
  | 'certification'
  // One achievement line.
  | 'achievement';

/* One input in an add form. The page renders these; addToMaster reads the same keys. */
export interface AddField {
  // The key addToMaster reads the typed value under.
  readonly key: string;
  // The label printed above the input.
  readonly label: string;
  // Blank is refused before anything is written.
  readonly required: boolean;
  // A textarea instead of a one-line input.
  readonly multiline?: boolean;
  // Example text inside the empty input.
  readonly placeholder?: string;
  // One line of help under the input.
  readonly help?: string;
}

/* What the operator typed, by field key. Strings only: every input on the form is text. */
export type AddValues = Readonly<Record<string, string>>;

// The bullets textarea, identical for every bulleted section, defined once.
const BULLETS_FIELD: AddField = {
  // Read by parseBullets.
  key: 'bullets',
  // Plain word for what each line becomes.
  label: 'Bullets',
  // A node may start with no bullets; ingest flags that as advisory only.
  required: false,
  // One bullet per line needs room.
  multiline: true,
  // Shows the trailing-#tag syntax by example.
  placeholder: 'Built X with Y, cutting Z by 40% #fastapi #postgres',
  // Tags are how the Tailor picks a bullet for a job, so the syntax is spelled out.
  help: 'One bullet per line. End a line with #tags so the Tailor can match it to jobs.',
};

/* The optional link on a certification or achievement (the `links?` field since d50775a).
   A label AND a url, like an identity link, because the resume prints the label as the
   anchor text and a credential link has no fixed name the way a project's "GitHub" does. */
const ENTRY_LINK_FIELDS: readonly AddField[] = [
  // Printed as the anchor text; required only when a url is given (checked in addToMaster).
  { key: 'link_label', label: 'Link label', required: false, placeholder: 'Credential' },
  // Must be http(s); blank means the entry gets no links key at all.
  { key: 'link_url', label: 'Link URL', required: false, placeholder: 'https://' },
];

/* The form for each kind. Required flags mirror checkMasterProfile's blocking checks, so the
   operator hears about a blank field before a version is attempted, not after. */
export const ADD_FIELDS: Readonly<Record<AddKind, readonly AddField[]>> = {
  // Identity links: both halves are printed, so both are required.
  link: [
    // The anchor text on the resume.
    { key: 'label', label: 'Label', required: true, placeholder: 'LinkedIn' },
    // Must be http(s); checked in addToMaster.
    { key: 'url', label: 'URL', required: true, placeholder: 'https://' },
  ],
  // The summary is one paragraph.
  summary: [{ key: 'text', label: 'Summary', required: true, multiline: true }],
  // A skill is a name and the resume group it prints under.
  skill: [
    // Printed exactly as typed.
    { key: 'name', label: 'Skill', required: true, placeholder: 'Kubernetes' },
    // Pick an existing group to keep the resume's skill lines tidy.
    { key: 'category', label: 'Group', required: true, placeholder: 'DevOps & Cloud' },
  ],
  // Experience: ingest requires company, role and both display dates.
  experience: [
    // The job title.
    { key: 'role', label: 'Role', required: true },
    // The employer.
    { key: 'company', label: 'Company', required: true },
    // Optional; null when blank.
    { key: 'location', label: 'Location', required: false },
    // Printed verbatim; the renderer does no date maths.
    { key: 'start_display', label: 'Start', required: true, placeholder: 'May 2026' },
    // "Present" for a current role.
    { key: 'end_display', label: 'End', required: true, placeholder: 'Present' },
    // The job's achievement lines.
    BULLETS_FIELD,
  ],
  // Projects: the two link labels the real resume already uses.
  project: [
    // The project title.
    { key: 'name', label: 'Project name', required: true },
    // Printed verbatim.
    { key: 'start_display', label: 'Start', required: true, placeholder: 'Jan 2026' },
    // Printed verbatim.
    { key: 'end_display', label: 'End', required: true, placeholder: 'Present' },
    // Stored as a "Live Demo" link when filled.
    { key: 'live_url', label: 'Live demo URL', required: false, placeholder: 'https://' },
    // Stored as a "GitHub" link when filled.
    { key: 'github_url', label: 'GitHub URL', required: false, placeholder: 'https://github.com/' },
    // The project's lines.
    BULLETS_FIELD,
  ],
  // Education: ingest requires institution, degree and both display dates.
  education: [
    // e.g. B.Tech.
    { key: 'degree', label: 'Degree', required: true },
    // The college.
    { key: 'institution', label: 'Institution', required: true },
    // Optional; null when blank.
    { key: 'field', label: 'Field of study', required: false },
    // Printed verbatim.
    { key: 'start_display', label: 'Start', required: true, placeholder: '2024' },
    // Printed verbatim.
    { key: 'end_display', label: 'End', required: true, placeholder: '2027' },
    // Pre-formatted, e.g. "8.4 CGPA"; null when blank.
    { key: 'grade_display', label: 'Grade', required: false },
    // Optional lines under the degree.
    BULLETS_FIELD,
  ],
  // A certification is a label plus the detail after the dash, and optionally one link.
  certification: [
    // The certification name.
    { key: 'label', label: 'Certification', required: true },
    // Usually the issuer; null when blank.
    { key: 'description', label: 'Issuer / detail', required: false },
    // The optional link pair, shared with achievements.
    ...ENTRY_LINK_FIELDS,
  ],
  // An achievement is the same fields.
  achievement: [
    // The achievement itself.
    { key: 'label', label: 'Achievement', required: true },
    // The qualifying detail; null when blank.
    { key: 'description', label: 'Detail', required: false },
    // The optional link pair, shared with certifications.
    ...ENTRY_LINK_FIELDS,
  ],
};

/* Mints one fresh node id. Injected so a test can name ids; the page passes randomNodeId. */
export type MintId = (prefix: string) => string;

/* The page's minter: `<kind>_<uuid>`, the same form attested skills already use. */
const randomNodeId: MintId = (prefix) => `${prefix}_${crypto.randomUUID()}`;

/* A typed value, trimmed; absent keys read as blank. */
function read(values: AddValues, key: string): string {
  // `?? ''` because a never-touched input has no key at all.
  return (values[key] ?? '').trim();
}

/* A blank optional field becomes null, which is what the contract types those fields as. */
function orNull(values: AddValues, key: string): string | null {
  // Read once, trimmed.
  const value = read(values, key);
  // Empty string would print as a blank line; null is the contract's "none".
  return value === '' ? null : value;
}

/* One bullet per non-blank line; trailing `#tag` words become that bullet's tags.
 * Only TRAILING tags, so "Ranked #1 of 300 teams" keeps its "#1" as text. A line that is
 * nothing but tags keeps its last word as text rather than becoming an empty bullet.
 * A tag must START WITH A LETTER (fixed 2026-11-01): "ranked #1" at the END of a line was
 * peeled as tag "1" and printed "ranked" with the rank gone, and "#100DaysOfCode" is a
 * name to print, not a keyword a job would match. The trade is deliberate: a digit-led
 * tech tag ("#3d") now stays visible text the operator can fix in the preview, where the
 * old rule silently deleted printed resume words. Letter-led tags with digits ("#k8s")
 * still peel. */
export function parseBullets(text: string, mintId: MintId): MasterBullet[] {
  // Lines, trimmed, blanks dropped.
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  // Each line to one bullet.
  return lines.map((line) => {
    // Words, so trailing tags can be peeled off the end.
    const words = line.split(/\s+/);
    // Tags in the order written.
    const tags: string[] = [];
    // Peel while the last word is a letter-led #tag, but never the only word left.
    // `[A-Za-z]` first so "#1" and "#100DaysOfCode" stay text (see the header).
    while (words.length > 1 && /^#[A-Za-z][\w-]*$/.test(words[words.length - 1] ?? '')) {
      // Without the '#', matching how stored tags look.
      tags.unshift((words.pop() ?? '').slice(1));
    }
    // A fresh id in the global id space; the text is what the Tailor rewords.
    return { id: mintId('bullet'), text: words.join(' '), tags };
  });
}

/* How building the next master ends. A union so the page cannot store a refusal. */
export type AddResult =
  // The next master, already through the ingest gate.
  | { readonly ok: true; readonly profile: MasterProfile }
  // Why not, in words the page shows verbatim.
  | { readonly ok: false; readonly message: string };

/* Append one node of `kind` to `base`. Pure: no network, no clock; ids come from mintId.
 * Appended LAST because array order is document order and every existing id stays valid. */
export function addToMaster(base: MasterProfile, kind: AddKind, values: AddValues, mintId: MintId): AddResult {
  // Required fields first, named, so a refusal says which box is empty.
  const missing = ADD_FIELDS[kind].find((field) => field.required && read(values, field.key) === '');
  // A blank required field never reaches the ingest gate.
  if (missing !== undefined) return { ok: false, message: `${missing.label} is required.` };

  // Every URL field must be http(s): a javascript: link would be stored and later rendered.
  for (const key of ['url', 'live_url', 'github_url', 'link_url']) {
    // Blank optional URLs are fine; they simply add no link.
    const url = read(values, key);
    // safeHref returns undefined for anything not http(s).
    if (url !== '' && safeHref(url) === undefined) return { ok: false, message: `${url} is not an http(s) link.` };
  }

  // A link url with no label would print as an empty anchor on the resume.
  if (read(values, 'link_url') !== '' && read(values, 'link_label') === '') return { ok: false, message: 'Link label is required when a link URL is given.' };

  // The bullets, parsed once; empty for kinds without a bullets field.
  const bullets = parseBullets(read(values, 'bullets'), mintId);
  /* A certification or achievement's link, as a spread: `{ links: [...] }` when a url was typed,
     `{}` otherwise. Never `links: []`: the key is optional and absent on every master before v9,
     and the approval page compares rebuilt entries byte for byte, so an empty array is a change. */
  const entryLinks = read(values, 'link_url') === '' ? {} : { links: [{ id: mintId('link'), label: read(values, 'link_label'), url: read(values, 'link_url') }] };
  // The next master, built per kind.
  let next: MasterProfile;
  // One branch per kind; the union makes a missing branch a compile error.
  switch (kind) {
    case 'link':
      // Identity is copied verbatim to every resume, so a new link goes there.
      next = { ...base, identity: { ...base.identity, links: [...base.identity.links, { id: mintId('link'), label: read(values, 'label'), url: read(values, 'url') }] } };
      break;
    case 'summary':
      // One summary only; replacing it would be an edit, which this page does not offer.
      if (base.summary !== null) return { ok: false, message: 'A summary already exists.' };
      // A node with an id, so tailored summaries can reference it.
      next = { ...base, summary: { id: mintId('summary'), text: read(values, 'text') } };
      break;
    case 'skill':
      // Name and group, exactly as typed.
      next = { ...base, skills: [...base.skills, { id: mintId('skill'), name: read(values, 'name'), category: read(values, 'category') }] };
      break;
    case 'experience':
      // ISO dates stay null: they are for sorting only and the form does not ask for them.
      next = {
        // Every other section carried over unchanged.
        ...base,
        // The old roles first, the new one last.
        experience: [
          // Existing roles keep their ids, so pinned applications still resolve.
          ...base.experience,
          // Every field the contract requires, nullable ones as null when blank.
          { id: mintId('exp'), role: read(values, 'role'), company: read(values, 'company'), location: orNull(values, 'location'), start_display: read(values, 'start_display'), end_display: read(values, 'end_display'), start_date: null, end_date: null, bullets },
        ],
      };
      break;
    case 'project': {
      // The two optional links, labelled the way the stored projects already are.
      const links = [
        // Live deployment first, matching the resume's existing order.
        { label: 'Live Demo', url: read(values, 'live_url') },
        // Then the source.
        { label: 'GitHub', url: read(values, 'github_url') },
      ]
        // Blank means no such link.
        .filter((link) => link.url !== '')
        // Each link is a node in the global id space.
        .map((link) => ({ id: mintId('link'), ...link }));
      // Same shape as experience, plus links.
      next = {
        // Every other section carried over unchanged.
        ...base,
        // The old projects first, the new one last.
        projects: [
          // Existing projects keep their ids.
          ...base.projects,
          // ISO dates null, as for experience.
          { id: mintId('proj'), name: read(values, 'name'), links, start_display: read(values, 'start_display'), end_display: read(values, 'end_display'), start_date: null, end_date: null, bullets },
        ],
      };
      break;
    }
    case 'education':
      // Field and grade are nullable; dates verbatim.
      next = {
        // Every other section carried over unchanged.
        ...base,
        // The old qualifications first, the new one last.
        education: [
          // Existing qualifications keep their ids.
          ...base.education,
          // Every contract field present.
          { id: mintId('edu'), degree: read(values, 'degree'), institution: read(values, 'institution'), field: orNull(values, 'field'), start_display: read(values, 'start_display'), end_display: read(values, 'end_display'), start_date: null, end_date: null, grade_display: orNull(values, 'grade_display'), bullets },
        ],
      };
      break;
    case 'certification':
      // Undated by design (profile-nodes.ts); bullets empty, the label is the line.
      next = { ...base, certifications: [...base.certifications, { id: mintId('cert'), label: read(values, 'label'), description: orNull(values, 'description'), bullets: [], ...entryLinks }] };
      break;
    case 'achievement':
      // Same shape as a certification, different section.
      next = { ...base, achievements: [...base.achievements, { id: mintId('ach'), label: read(values, 'label'), description: orNull(values, 'description'), bullets: [], ...entryLinks }] };
      break;
  }

  // The same gate every upload and paste passes: duplicate ids, blank required text, shape.
  const checked = checkMasterProfile(next);
  // Refused with the first blocking reason, so the operator sees what the gate saw.
  if (!checked.ok) {
    // The first blocking finding names a path and a problem.
    const first = checked.findings.find((finding) => finding.severity === 'blocking');
    // Path plus problem; a generic line only if the gate gave none.
    return { ok: false, message: first ? `${first.path}: ${first.problem}` : 'The profile did not pass validation.' };
  }
  // The gate's output, with the explicit nulls the table's check constraint requires.
  return { ok: true, profile: checked.profile };
}

/* How a save ends: the stored master and its version, or why not. */
export type SaveAdditionOutcome =
  // Landed as a new version.
  | { readonly ok: true; readonly profile: MasterProfile; readonly version: number }
  // Nothing was written.
  | { readonly ok: false; readonly message: string };

/* Read the newest master, append, insert as N+1.
 * ponytail: read-then-insert is not atomic; two saves in the same second can each build on
 * version N and the later one drops the earlier one's node. Same ceiling as attestSkill; move to
 * a database function if two tabs ever add at once. */
export async function saveMasterAddition(client: SupabaseClient, kind: AddKind, values: AddValues): Promise<SaveAdditionOutcome> {
  // The newest version, never the copy the page loaded at mount.
  const latest = await loadCurrentMasterProfile(client);
  // A failed read must not be mistaken for "no profile" and build from nothing.
  if (latest.kind === 'failed') return { ok: false, message: `Could not read your master profile: ${latest.message}` };
  // Identity needs a name and email the form does not ask for, so an add needs a base.
  if (latest.kind === 'none') return { ok: false, message: 'No master profile is stored yet. Upload your resume first.' };
  // The pure build, with real random ids.
  const built = addToMaster(latest.profile, kind, values, randomNodeId);
  // Refused before any write.
  if (!built.ok) return built;
  // Insert-only; the database assigns the version and content hash.
  const stored = await storeMasterProfile(client, built.profile);
  // Each refusal in the store's own words.
  if (stored.kind !== 'stored') return { ok: false, message: `Not saved: ${storeRefusalMessage(stored)}.` };
  // The profile as stored and the version the database assigned.
  return { ok: true, profile: built.profile, version: stored.version };
}
