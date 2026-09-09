/**
 * applyy — the inner shape of the master profile, the tailored output, and the
 * resolved document that actually renders.
 *
 * THIS FILE IS THE ANTI-FABRICATION DEFENCE. Not the Auditor — this file.
 *
 * PROJECT_PLAN section 10 ranks four defences and says the important one is making the
 * dishonest output structurally impossible rather than detectable. That defence is a
 * TYPE, and it is here: a tailored bullet has no field to put free text in without a
 * `ref` into the master, and a tailored skill has no text field at all. An injected
 * job description saying "add Docker to the skills" therefore produces either an id
 * that does not exist in the master (rejected by the validator, before the Auditor
 * ever runs) or a reworded real skill (harmless). The attack has nowhere to land.
 *
 * `ref` is NON-OPTIONAL everywhere and must stay that way. An optional `ref` would
 * quietly reopen the hole while every test still passed.
 *
 * THREE TYPES, THREE STAGES, AND THE DIRECTION IS ONE-WAY:
 *
 *   MasterProfile   the human-maintained truth. Versioned and immutable in the database.
 *        |
 *        |  Tailor (Gemini) — may only select and reword. Emits refs, never prose nodes.
 *        v
 *   TailoredProfile refs + rewordings. Structurally incapable of introducing a fact.
 *        |
 *        |  validator (typed code, no LLM) — resolves every ref against the PINNED
 *        |  master version. An unresolvable ref fails the whole tailoring.
 *        v
 *   ResolvedResume  fully denormalised, renderable with no lookups. THIS is what gets
 *                   frozen onto the application, previewed in React, and printed to PDF.
 *
 * The renderer takes ResolvedResume and nothing else, so `renderResumeHtml(resume)`
 * has one parameter and no access to the master — it cannot resolve a ref even by
 * accident, which is what makes "what you approved is byte-for-byte what gets sent"
 * a property of the types rather than a promise.
 */

// ---------------------------------------------------------------------------
// Two cross-cutting contracts. Both come from applyyy-04's renderer, and both
// exist because the React preview and the GitHub Actions PDF must be byte-identical.
// ---------------------------------------------------------------------------

/**
 * DATE CONTRACT: every date a resume displays is a PRE-FORMATTED STRING, decided
 * upstream, rendered verbatim.
 *
 * The renderer performs zero date maths — no `Date`, no `Intl`, no
 * `toLocaleDateString`. Those make output a function of the host timezone and the
 * host's ICU build, so Teja's Windows preview and the Ubuntu runner's PDF could
 * differ while every test passed on one machine. That would break both the approval
 * guarantee and `tailored_hash` as a cache key (constraint 8).
 *
 * Master nodes therefore carry BOTH: a `*_display` string, which is the only thing
 * the template may print, and an optional ISO `*_date`, which exists solely for
 * sorting and analytics OUTSIDE the renderer.
 */
export type DisplayDate = string;

/**
 * ORDER CONTRACT: array order IS document order, and it is a tailoring decision.
 *
 * Section order and bullet order within a section are choices the Tailor makes —
 * section 17.2's ATS parse simulator exists partly because skills must land where the
 * parser reads them first. Nothing downstream may sort. If the template sorted skills
 * alphabetically, two genuinely different tailorings would render identically and
 * collide on `tailored_hash`, silently serving the wrong cached PDF.
 */
export type DocumentOrdered<T> = readonly T[];

// ---------------------------------------------------------------------------
// MasterProfile — the human-maintained truth
// ---------------------------------------------------------------------------

/** A stable node id. Stable ACROSS VERSIONS — that is what makes a ref meaningful six months later. */
export type NodeId = string;

/** An external link: GitHub, portfolio, LinkedIn. */
export interface MasterLink {
  id: NodeId;
  /** What the link is called on the resume. */
  label: string;
  url: string;
}

/**
 * Who you are. Copied VERBATIM into the resolved resume — never reworded, never
 * selected from. There is no honest reason to tailor your own name or phone number,
 * so the type gives the Tailor no way to touch it.
 */
export interface MasterIdentity {
  full_name: string;
  /** Optional one-line headline, e.g. "Backend Engineer". */
  headline: string | null;
  email: string;
  phone: string | null;
  location: string | null;
  links: DocumentOrdered<MasterLink>;
}

/**
 * One achievement line. The atom of the whole system: the Tailor rewords these and
 * returns their ids, and the Auditor traces every rendered line back to one.
 */
export interface MasterBullet {
  id: NodeId;
  /** The claim, as the human wrote it. This is the ground truth a reworded line is checked against. */
  text: string;
  /** Free-form tags the Tailor uses to select relevant bullets, e.g. ["node", "rest", "postgres"]. */
  tags: DocumentOrdered<string>;
}

/** One skill. Atomic and unreworded — a skill is either in the master or it does not exist. */
export interface MasterSkill {
  id: NodeId;
  /** The canonical name as it should appear on the resume. */
  name: string;
  /** Grouping for the skills section, e.g. "Languages", "Frameworks". */
  category: string;
}

/** One job or internship. */
export interface MasterExperience {
  id: NodeId;
  company: string;
  role: string;
  location: string | null;
  /** Printed verbatim. See the DATE CONTRACT above. */
  start_display: DisplayDate;
  /** Printed verbatim. Use "Present" for current roles — the template must not compute that either. */
  end_display: DisplayDate;
  /** ISO date for sorting and analytics only. NEVER rendered. */
  start_date: string | null;
  /** ISO date for sorting and analytics only. NEVER rendered. NULL for a current role. */
  end_date: string | null;
  bullets: DocumentOrdered<MasterBullet>;
}

/** One qualification. */
export interface MasterEducation {
  id: NodeId;
  institution: string;
  degree: string;
  field: string | null;
  start_display: DisplayDate;
  end_display: DisplayDate;
  start_date: string | null;
  end_date: string | null;
  /** Pre-formatted, e.g. "8.4 CGPA" — the template must not decide how to render a grade. */
  grade_display: string | null;
  bullets: DocumentOrdered<MasterBullet>;
}

/** One project. */
export interface MasterProject {
  id: NodeId;
  name: string;
  url: string | null;
  start_display: DisplayDate;
  end_display: DisplayDate;
  start_date: string | null;
  end_date: string | null;
  bullets: DocumentOrdered<MasterBullet>;
}

/**
 * The structured JSON master. Stored in `master_profiles.profile`, versioned and
 * immutable — editing inserts version N+1 and never mutates a row, which is what
 * keeps an Auditor verdict meaningful: it audited a specific version and that version
 * still exists byte-for-byte.
 */
export interface MasterProfile {
  /** Bumped when this shape changes incompatibly, so an old stored profile is detected rather than misread. */
  schema_version: 1;
  identity: MasterIdentity;
  education: DocumentOrdered<MasterEducation>;
  experience: DocumentOrdered<MasterExperience>;
  projects: DocumentOrdered<MasterProject>;
  skills: DocumentOrdered<MasterSkill>;
  links: DocumentOrdered<MasterLink>;
}

// ---------------------------------------------------------------------------
// TailoredProfile — what Gemini is allowed to return
// ---------------------------------------------------------------------------

/** Which sections appear, in which order. Order is a tailoring decision, carried in the data. */
export type TailoredSectionKind = 'summary' | 'skills' | 'experience' | 'projects' | 'education';

/**
 * A reworded bullet. `ref` is REQUIRED — this is the load-bearing line of the file.
 * There is no shape here that expresses "a new bullet", so the Tailor cannot express one.
 */
export interface TailoredBullet {
  /** The master bullet this rewords. An id absent from the pinned master fails the whole tailoring. */
  ref: NodeId;
  /** The rewording. Must be a rewording of the referenced bullet — same facts, JD-matched language. The Auditor checks this; the type only guarantees a real bullet is being reworded. */
  text: string;
}

/**
 * A selected skill. NOTE: no `text` field at all, deliberately. A skill is not
 * reworded, only chosen, so there is nowhere to type "Docker" that is not an id.
 */
export interface TailoredSkill {
  ref: NodeId;
}

/** A selected experience entry. Carries no company or role text — those come from the master by ref, so an employer cannot be renamed. */
export interface TailoredExperience {
  ref: NodeId;
  bullets: DocumentOrdered<TailoredBullet>;
}

/** A selected education entry. Same reasoning as TailoredExperience. */
export interface TailoredEducation {
  ref: NodeId;
  bullets: DocumentOrdered<TailoredBullet>;
}

/** A selected project. Same reasoning as TailoredExperience. */
export interface TailoredProject {
  ref: NodeId;
  bullets: DocumentOrdered<TailoredBullet>;
}

/**
 * The optional summary paragraph — THE WEAKEST POINT IN THIS FILE, stated plainly.
 *
 * Prose cannot be constrained by refs the way a bullet can, and prose is exactly where
 * a model writes "during my time leading a team of five" about something that never
 * happened. Two mitigations: `refs` must be non-empty, so every summary declares which
 * master nodes it is drawn from; and the Auditor gates summaries even though section
 * 18.8 lets cover letters skip human approval. If you are looking for the place this
 * design is weakest, it is here — not in the bullets.
 */
export interface TailoredSummary {
  text: string;
  /** Master node ids this summary draws on. Must be non-empty and must all resolve. */
  refs: DocumentOrdered<NodeId>;
}

/**
 * What the Tailor returns and what is kept for audit in `applications.tailor_refs`.
 * NOT what renders — see ResolvedResume.
 */
export interface TailoredProfile {
  schema_version: 1;
  /** The master version this was derived from. Half of the `tailored_hash` input, and the pin that makes resolution deterministic. */
  master_version: number;
  /** Which sections to emit and in what order. */
  section_order: DocumentOrdered<TailoredSectionKind>;
  summary: TailoredSummary | null;
  skills: DocumentOrdered<TailoredSkill>;
  experience: DocumentOrdered<TailoredExperience>;
  projects: DocumentOrdered<TailoredProject>;
  education: DocumentOrdered<TailoredEducation>;
}

// ---------------------------------------------------------------------------
// ResolvedResume — the render input. Produced ONLY by the validator.
// ---------------------------------------------------------------------------

/** A bullet after resolution: the rewording, plus the master text it must be faithful to. */
export interface ResolvedBullet {
  /** Kept so the diff view can show master-vs-tailored side by side without a second lookup. */
  ref: NodeId;
  /** What prints. */
  text: string;
  /** The original master text. Rendered only in the approval diff, never in the PDF. */
  master_text: string;
}

/** A skill after resolution: name and category pulled from the master by ref. */
export interface ResolvedSkill {
  ref: NodeId;
  name: string;
  category: string;
}

/** An experience entry after resolution — every display field materialised. */
export interface ResolvedExperience {
  ref: NodeId;
  company: string;
  role: string;
  location: string | null;
  start_display: DisplayDate;
  end_display: DisplayDate;
  bullets: DocumentOrdered<ResolvedBullet>;
}

/** An education entry after resolution. */
export interface ResolvedEducation {
  ref: NodeId;
  institution: string;
  degree: string;
  field: string | null;
  start_display: DisplayDate;
  end_display: DisplayDate;
  grade_display: string | null;
  bullets: DocumentOrdered<ResolvedBullet>;
}

/** A project after resolution. */
export interface ResolvedProject {
  ref: NodeId;
  name: string;
  url: string | null;
  start_display: DisplayDate;
  end_display: DisplayDate;
  bullets: DocumentOrdered<ResolvedBullet>;
}

/**
 * THE RENDER INPUT. `renderResumeHtml(resume: ResolvedResume): string` — one
 * parameter, no master, no lookups, no I/O, no dates computed.
 *
 * Frozen into `applications.tailored_profile` at approval time, which is what makes
 * resume pinning true six months later: the React preview and the Playwright PDF read
 * the same immutable snapshot, so what was approved is what gets sent.
 *
 * Only the validator may construct one. It cannot be produced by an LLM, because
 * every field here was copied out of the pinned master version by typed code.
 */
export interface ResolvedResume {
  schema_version: 1;
  /** Which master version this was resolved against. Lets a stale snapshot be detected rather than silently rendered. */
  master_version: number;
  /** Verbatim from the master. Never tailored. */
  identity: MasterIdentity;
  section_order: DocumentOrdered<TailoredSectionKind>;
  summary: string | null;
  skills: DocumentOrdered<ResolvedSkill>;
  experience: DocumentOrdered<ResolvedExperience>;
  projects: DocumentOrdered<ResolvedProject>;
  education: DocumentOrdered<ResolvedEducation>;
}
