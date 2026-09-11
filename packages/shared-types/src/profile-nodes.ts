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

/**
 * A stable node id. Stable ACROSS VERSIONS — that is what makes a ref meaningful six
 * months later.
 *
 * ── DECIDED 2026-09-10: ONE GLOBAL ID SPACE FOR THE WHOLE MasterProfile ──────────
 *
 * **Every NodeId must be unique across the ENTIRE master profile — across experience,
 * projects, education, skills, links and every bullet nested inside them. Not unique
 * per section. Not unique per kind.**
 *
 * This was previously undecided, and the ambiguity was load-bearing: the validator
 * indexes master bullets into one flat `Map` keyed by id, which assumes a global space,
 * while a reader of this file could just as reasonably assume per-section. A reader who
 * assumed per-section would be right to call the flat index a bug, and a reader who
 * assumed global would be right to call a per-section ingest check a bug. Both cannot
 * be right, so the contract has to say which.
 *
 * WHY GLOBAL IS THE ONLY COHERENT ANSWER — it follows from the tailored types, it is
 * not a preference. `TailoredBullet` is `{ ref, text }` and `TailoredSkill` is
 * `{ ref }`: a bare id with NO section qualifier and no kind tag. Resolution therefore
 * has nothing to go on but the id itself. Under per-section uniqueness a bullet ref
 * could resolve to a skill, or to a bullet under a different parent, and the type
 * system offers a consumer no way to disambiguate. Adding a qualifier to every ref
 * would be the alternative design; it is strictly more machinery for no gain, since a
 * human authoring the master can simply not reuse an id.
 *
 * WHAT GOES WRONG IF INGEST ONLY CHECKS PER-SECTION — and it fails SILENTLY, which is
 * why this is in the type rather than in a style guide. A `Map` overwrites on duplicate
 * key, so a duplicate id anywhere in the master silently replaces the earlier entry.
 * The misattribution check (see `TailoredBullet`) then compares the tailored parent
 * against the WRONG stored parent, and a genuine misattribution passes as clean. The
 * tailoring looks clean, the Auditor reports clean, and the honesty guarantee has
 * stopped holding with nothing anywhere reporting a problem.
 *
 * That is measurable rather than hypothetical: a per-section uniqueness checker — the
 * plausible wrong design, and arguably the more natural-reading one — passed **34 of 36**
 * tests written against the ingest path. The two that failed were the cross-section
 * collision and a bullet id colliding with a SKILL id. The within-section duplicate
 * test, which is the case anyone writes first, passed under both designs. So the wrong
 * design catches the mistake people actually make, and still leaves the audit
 * corruptible.
 *
 * REQUIRED OF THE INGEST VALIDATOR: reject a master profile with any duplicate NodeId
 * across all kinds, and FAIL CLOSED. It is the only place this can be enforced —
 * `type NodeId = string` buys no enforcement, and by the time a ref is being resolved
 * the collision has already been silently absorbed.
 */
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
  /**
   * Every address this project has, in document order — a live deployment AND a
   * source repository, not one or the other.
   *
   * REPLACED A SINGLE `url: string | null` ON 2026-09-11, and the single slot was
   * WRONG rather than merely limiting. The real resume has a project carrying both
   * a live URL and a GitHub URL, so ingest had to silently discard one of the two
   * on every upload — a fact present in the document and absent from the contract,
   * which is the same class of loss as the achievements and certifications below.
   *
   * WHY NOT A SECOND SCALAR (`url2`, `repo_url`). It makes the loss smaller without
   * making it impossible — a third address is back to dropping — and it leaves the
   * original field meaning "the first one, whichever that happened to be", which is
   * a name that documents nothing. Renaming to `live_url`/`repo_url` asserts a
   * semantic the parser cannot actually verify: a project link is sometimes a demo
   * video or a paper.
   *
   * WHY `MasterLink` AND NOT `readonly string[]`. Two reasons and the second is the
   * load-bearing one. A link needs a LABEL to render ("Live" vs "Source"), and a
   * `MasterLink` carries a `NodeId` — so a project link lives in the same global id
   * space as everything else and is RECONCILED across re-uploads exactly like an
   * identity link. A bare string array would have no id, so a re-upload could not
   * tell "the GitHub link is unchanged" from "a new link appeared", which is the
   * precise failure `master-ingest` exists to prevent.
   *
   * Empty is normal and means the project has no public address. That is a
   * different fact from "the parser did not find one", and nothing here records the
   * second — deliberately, because the master is human-maintained truth, not a
   * parser's confidence report.
   */
  links: DocumentOrdered<MasterLink>;
  start_display: DisplayDate;
  end_display: DisplayDate;
  start_date: string | null;
  end_date: string | null;
  bullets: DocumentOrdered<MasterBullet>;
}

/**
 * THE MASTER SUMMARY — A NODE WITH A STABLE `NodeId`, NEVER A BARE `summary: string`.
 *
 * `TailoredSummary` below calls the summary the weakest point in this file, and it
 * is right: prose cannot be constrained by refs the way a bullet can. But read that
 * note carefully — the danger was never that a summary EXISTS. It is a summary with
 * nothing behind it. `TailoredSummary.refs` is already required and already
 * non-empty, so the Tailor must declare which master nodes its paragraph is drawn
 * from; before this type existed the one thing it could not declare was the human's
 * OWN summary, because that had no id to point at.
 *
 * So this closes the loop rather than widening the hole: the paragraph Teja wrote
 * himself becomes a resolvable ref like every other node, and "reword my summary"
 * stops being indistinguishable from "invent a summary". Stored as a bare string it
 * would have been the one piece of prose in the system that the Tailor could draw on
 * with no way for the validator to check that it had.
 *
 * WHY NOT REUSE `MasterBullet`. A bullet carries `tags`, which exist so the Tailor
 * can SELECT among many. There is one summary; selection is not the operation, and a
 * tags array on a singleton is a field whose only possible value is noise.
 */
export interface MasterSummary {
  id: NodeId;
  /** The paragraph as the human wrote it. Ground truth for any rewording that refs it. */
  text: string;
}

/**
 * One achievement — a hackathon placing, a ranking, a scholarship.
 *
 * NO DATE FIELDS, AND THAT IS A DECISION RATHER THAN AN OMISSION. The real resume
 * writes achievements as undated lines, so a `date_display` here would have exactly
 * one honest value — the empty string — and one tempting dishonest one: a date
 * inferred by the parser. The DATE CONTRACT at the top of this file exists because a
 * rendered date must be decided upstream and printed verbatim; a field with no
 * upstream source cannot satisfy it. Add dates when the document grows them.
 *
 * A BULLETED PARENT, like experience and projects, so its detail lines are ordinary
 * `MasterBullet`s. That is what makes an achievement TAILORABLE at all: the Tailor
 * reworks it through `TailoredBullet`, which is `{ ref, text }`, so it can rephrase
 * "Winner, national hackathon" for a JD without being able to promote it to "Winner,
 * international hackathon". Giving this type its own bespoke free-text field would
 * have opened a second fabrication surface parallel to the one the whole file
 * defends. Usually empty — most achievements are one line.
 */
export interface MasterAchievement {
  id: NodeId;
  /** The achievement itself, e.g. "Winner — Smart India Hackathon 2025". Copied verbatim; never reworded. */
  label: string;
  /** The qualifying detail after the label, e.g. "national finals, 300+ teams". Verbatim. Null when the label says everything. */
  description: string | null;
  bullets: DocumentOrdered<MasterBullet>;
}

/**
 * One certification. Structurally identical to `MasterAchievement` and deliberately
 * a SEPARATE interface rather than an alias: they are different resume sections with
 * different match keys in `master-ingest`, and one name covering both would make a
 * future divergence a breaking rename instead of an added field.
 *
 * WHY `description` AND NOT `issuer`, given every certification in the real resume is
 * written `Name – Issuer`. `issuer` asserts a semantic the parser cannot verify: the
 * half after the dash is an issuing body on some lines and a platform or a year on
 * others, and a field named `issuer` holding "2025" is a name that lies. `description`
 * claims only what is true of every line — the qualifying detail that follows the
 * label. Rename it the day the parser can actually tell those apart.
 *
 * NO DATES, for the same reason as `MasterAchievement`: the document has none.
 */
export interface MasterCertification {
  id: NodeId;
  /** The certification name, e.g. "AWS Certified Cloud Practitioner". Verbatim. */
  label: string;
  /** Whatever follows the dash, e.g. "Amazon Web Services". Verbatim. Null when absent. */
  description: string | null;
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
  /**
   * The human's own summary paragraph, or null when there is none.
   *
   * REQUIRED FIELD, NULLABLE VALUE — not an optional property. `summary?:` would let
   * a construction site that forgot the summary compile clean and store a profile
   * whose paragraph had been dropped, which is the exact bug this whole change
   * exists to fix. `| null` forces every site to state which case it is in.
   */
  summary: MasterSummary | null;
  education: DocumentOrdered<MasterEducation>;
  experience: DocumentOrdered<MasterExperience>;
  projects: DocumentOrdered<MasterProject>;
  skills: DocumentOrdered<MasterSkill>;
  /**
   * Achievements and certifications. REQUIRED ARRAYS, POSSIBLY EMPTY — never
   * optional, for the same reason as `summary` above and one more: an empty array
   * and a missing property are the same value to every consumer that reads
   * `profile.achievements.length`, but only the required form makes the compiler
   * name every construction site that has not been updated. Weakening these to `?:`
   * would buy a smaller diff today by converting a compile error into a silent data
   * loss, which is the trade this file never takes.
   */
  achievements: DocumentOrdered<MasterAchievement>;
  certifications: DocumentOrdered<MasterCertification>;
  links: DocumentOrdered<MasterLink>;
}

// ---------------------------------------------------------------------------
// TailoredProfile — what Gemini is allowed to return
// ---------------------------------------------------------------------------

/**
 * Which sections appear, in which order. Order is a tailoring decision, carried in
 * the data.
 *
 * `achievements` and `certifications` joined this union on 2026-09-11. They had to:
 * a section the master can store but `section_order` cannot name is a section the
 * renderer has no instruction to emit, so adding the master types alone would have
 * moved the silent drop from ingest to tailoring rather than removing it.
 */
export type TailoredSectionKind =
  | 'summary'
  | 'skills'
  | 'experience'
  | 'projects'
  | 'education'
  | 'achievements'
  | 'certifications';

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
 * A selected achievement. Carries NO `label` and NO `description` — those come from
 * the master by ref, so "Winner" cannot be tailored into "International Winner".
 * Same reasoning as `TailoredExperience`, and it matters more here: an achievement
 * line is a bare superlative with no surrounding context to contradict an inflated
 * one, so it is the cheapest place in a resume to lie and the hardest to spot.
 */
export interface TailoredAchievement {
  ref: NodeId;
  bullets: DocumentOrdered<TailoredBullet>;
}

/** A selected certification. Same reasoning again: the name and the issuer are the master's, by ref. */
export interface TailoredCertification {
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
 *
 * NARROWED 2026-09-11, NOT CLOSED. `MasterSummary` now exists, so the human's own
 * summary paragraph has a `NodeId` and `refs` can name it — which means "reword the
 * summary I wrote" is finally expressible as a resolvable ref instead of being
 * indistinguishable from "invent a summary". Before that node existed, the one source
 * a summary most obviously draws on was the one thing it could not cite. The residual
 * weakness is unchanged and still real: `text` is free prose, and `refs` proves what
 * the paragraph was DRAWN FROM, never that it is faithful to it. That last step is the
 * Auditor's, and it is judgement rather than structure.
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
  /* Required arrays, same reasoning as on `MasterProfile`: a Tailor response that
     omitted these would otherwise parse clean and render a resume missing two
     sections, with the omission indistinguishable from a deliberate choice. */
  achievements: DocumentOrdered<TailoredAchievement>;
  certifications: DocumentOrdered<TailoredCertification>;
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
  /* Copied whole from the master project, label and all. `MasterLink` rather than a
     resolved variant because a link has no tailorable part: the validator carries it
     across unchanged, so a second shape would differ from this one only in name. */
  links: DocumentOrdered<MasterLink>;
  start_display: DisplayDate;
  end_display: DisplayDate;
  bullets: DocumentOrdered<ResolvedBullet>;
}

/**
 * An achievement after resolution — `label` and `description` materialised from the
 * master by the validator, bullets resolved like any other.
 *
 * No dates, matching `MasterAchievement`. There is nothing here for the renderer to
 * decide: every string prints verbatim, which is what keeps the React preview and
 * the Playwright PDF byte-identical.
 */
export interface ResolvedAchievement {
  ref: NodeId;
  label: string;
  description: string | null;
  bullets: DocumentOrdered<ResolvedBullet>;
}

/** A certification after resolution. Same shape and same reasoning as ResolvedAchievement. */
export interface ResolvedCertification {
  ref: NodeId;
  label: string;
  description: string | null;
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
  /* Stays a bare string, and only here. This is the END of the pipeline: the
     paragraph has already been checked against its refs by the validator, so an id
     on it would be an id nothing can look anything up with — the renderer has no
     master to resolve against, by design. The id lives on `MasterSummary`, which is
     where a ref needs to land. */
  summary: string | null;
  skills: DocumentOrdered<ResolvedSkill>;
  experience: DocumentOrdered<ResolvedExperience>;
  projects: DocumentOrdered<ResolvedProject>;
  education: DocumentOrdered<ResolvedEducation>;
  achievements: DocumentOrdered<ResolvedAchievement>;
  certifications: DocumentOrdered<ResolvedCertification>;
}
