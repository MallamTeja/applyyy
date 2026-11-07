// THE TAILOR RUNNER — one job in, one verdict out.
//
// This is the piece `_shared/tailor/` was missing. `prompt.ts` builds the call and
// `validator.ts` judges the answer, but nothing joined them, which is why this tree had
// zero non-test importers while looking complete. Deliberately the same shape as
// `../match/scorer.ts`: a factory taking a model seam plus the trusted half of the
// inputs, returning a function over one posting.
//
// PURE OF EVERYTHING EXCEPT THE MODEL. No database, no clock, no Gemini import. The
// `callLlm` seam is what keeps this unit testable with no key pool and no network, and
// it is also what lets this module run under `node --test` at all: `../gemini/` is
// Deno-only (`jsr:` imports, `Deno.env`), so importing it here would make these tests
// unrunnable outside Deno. Persisting the verdict is `persist.ts`'s job; deciding it is
// this file's.
//
// An earlier version of this comment also cited three open `exactOptionalPropertyTypes`
// errors in `../gemini/client.ts` as a reason to stay clear. Those were closed by
// `db98d6e` on 2026-09-18, mid-build. The seam is not why they mattered and the reason
// above stands on its own — recorded rather than silently deleted, because a rationale
// that quietly loses one of its two legs is worth knowing about.
//
// THE DISTINCTION THIS MODULE EXISTS TO HOLD: a model that DID NOT ANSWER and a model
// that answered DISHONESTLY are different events.
//   - did not answer (prose instead of JSON, or JSON of the wrong shape) -> THROW.
//     Nothing was judged, so there is no verdict; reporting one would invent it.
//   - answered dishonestly (a ref that resolves to nothing, a stale pin) -> RETURN a
//     refusal carrying its violations, because that IS a verdict and `validator.ts:70`
//     requires it reach the dashboard "rather than lose them in a stack trace".
// Collapsing either into the other is §5's pattern: malformed data becoming an answer.

// The prompt assembly that fences untrusted posting text out of the instruction region.
import { buildBulletRewritePrompt, buildTailorPrompt, type TailorPrompt } from "./prompt.ts";
// The honesty gate. The ONLY constructor of a `ResolvedResume`, per its own header.
import { validateTailoredProfile, type TailorViolation } from "./validator.ts";
// The posting's skill terms, deterministic and vocabulary-gated, for selected_jd_keywords.
import { extractJdKeywords, keywordAppearsIn } from "./jd-keywords.ts";
// Stored postings may be raw HTML; every reader here sees the text (N1, 2026-11-07).
import { postingText } from "./posting-text.ts";
// The contract, reached through this stream's single re-export module. Nothing here
// redefines one of these — a redefined type does not fail, it drifts.
import type { MasterProfile, ResolvedResume, TailoredProfile } from "../contracts/shared-types.ts";

// What a model call looks like from here: a prompt in, raw response text out.
//
// RETURNS A STRING, NOT A PARSED OBJECT, for the same reason `scorer.ts` does — the
// real transport hands back text, and parsing it is a failure surface that belongs
// under test. A seam typed as returning a clean object would quietly move the riskiest
// step outside the boundary being tested.
export type TailorLlmCaller = (prompt: TailorPrompt) => Promise<string>;

// The trusted half of the inputs, supplied once when the tailorer is built rather than
// per call: they do not vary between postings in a run, and threading them through
// every call site would invite a caller to vary them by accident.
export interface TailorDeps {
  // How to reach the model. Injected; see the header.
  readonly callLlm: TailorLlmCaller;
  // Teja's own versioned profile. TRUSTED — the only candidate text allowed to reach
  // the instruction region.
  readonly master: MasterProfile;
  // The pinned version the model must echo back, so a tailoring computed against a
  // different snapshot is detectable rather than silently rendered.
  readonly masterVersion: number;
}

// The untrusted half: everything scraped from the posting, named so the trust boundary
// is visible in the type rather than remembered by the caller.
export interface TailorJobInput {
  // UNTRUSTED. Scraped.
  readonly jobTitle: string;
  // UNTRUSTED. Scraped.
  readonly company: string;
  // UNTRUSTED. Scraped.
  readonly jobDescription: string;
}

// The verdict. A discriminated union rather than a nullable resume, so a caller cannot
// reach for `.resume` without first deciding what to do about a refusal — and so the
// violations have somewhere to live other than a thrown stack.
export type TailorOutcome =
  // Safe to persist and hand onward to the Auditor.
  // `refs` is the raw ref-based output the resume was resolved from. Carried so it can
  // be persisted to `tailor_refs`: the Auditor's summary-ref check (audit/detector.ts:503)
  // reads that column, and nothing wrote it, so the check could never fire.
  // `jdKeywords` is the posting's skill terms (jd-keywords.ts), carried ON the verdict so
  // persist.ts writes them in the same statement as the resume they were measured against.
  // `dedupedRefs` (2026-11-05) lists every repeated ref dedupeRepeatedRefs dropped before validation: empty
  // for a clean answer, and persisted in the event so a prompt that repeats itself stays visible.
  // `retry` (2026-11-05): null when the first answer passed; else what failed first and which bullets the
  // one-shot rewrite replaced, persisted in the event so the retry's yield can be measured.
  // `skillsAdded` / `skillsDropped` (2026-11-06) list every skill ref shapeSkillGroups appended (floor
  // top-ups) or removed (a model pick in a group the posting never touches); both persisted in the event
  // so the reshaping is never silent.
  | { readonly kind: "tailored"; readonly resume: ResolvedResume; readonly refs: TailoredProfile; readonly jdKeywords: readonly string[]; readonly dedupedRefs: readonly DedupedRef[]; readonly skillsAdded: readonly string[]; readonly skillsDropped: readonly string[]; readonly retry: null | { readonly firstViolations: readonly TailorViolation[]; readonly rewrittenRefs: readonly string[] } }
  // Never persisted as a profile; the reasons go to the dashboard and the row fails.
  // `retry` (2026-11-05): null when no retry ran; else the first attempt's violations and how the retry ended.
  | { readonly kind: "refused"; readonly violations: readonly TailorViolation[]; readonly retry: null | { readonly firstViolations: readonly TailorViolation[]; readonly result: "still_invalid" | "reply_unusable" } };

// One copy of a ref the model repeated inside one section, which dedupeRepeatedRefs dropped.
export interface DedupedRef {
  // The repeated node id.
  readonly ref: string;
  // The section it repeated in, in the validator's own words ("skills", "summary refs", ...).
  readonly where: string;
}

/* NORMALISATION, NOT LENIENCY (2026-11-05). The model sometimes lists one master node twice in the same
 * section (live: EA "Data Science Intern", match 84, failed on duplicate_ref skill_python in skills).
 * A repeat adds no claim: the second copy points at the very node the first one does. So, BEFORE the
 * validator, each section keeps the FIRST copy of each ref and drops the rest, deterministically.
 *
 * What this does NOT do: it never adds, rewrites or vouches for anything. Every surviving ref is still
 * resolved against the master, every bullet token still checked, and a ref repeated ACROSS two sections
 * is left alone, so the validator still refuses it (that is a wrong-section claim, not a repeat). The
 * validator itself is unchanged and still refuses duplicates: rebuildOriginal (web tailoredEdits.ts)
 * re-validates the STORED refs, which are this deduplicated profile, so the rebuild still equals the
 * snapshot. And the repair is reported (dedupedRefs), never silent: validator.ts:405 warns that silent
 * repair hides a misbehaving prompt. Exported for the test. */
export function dedupeRepeatedRefs(tailored: TailoredProfile): { readonly profile: TailoredProfile; readonly deduped: readonly DedupedRef[] } {
  // Every dropped copy, in document order.
  const deduped: DedupedRef[] = [];
  // Keeps the first item per ref in one section; the rest are recorded and dropped.
  const firstOnly = <T>(items: readonly T[], refOf: (item: T) => string, where: string): T[] => {
    // Refs already kept in this section only: a repeat across sections is the validator's to refuse.
    const seen = new Set<string>();
    // Order kept: the first copy stays where the model put it.
    return items.filter((item) => {
      // The item's node id.
      const ref = refOf(item);
      // A repeat: recorded, then dropped.
      if (seen.has(ref)) {
        deduped.push({ ref, where });
        return false;
      }
      // The first copy: kept.
      seen.add(ref);
      return true;
    });
  };
  // Each ref-bearing section, named as validator.ts names it in its duplicate_ref violations.
  const profile: TailoredProfile = {
    // Everything that carries no ref list, as parsed.
    ...tailored,
    // The summary's own ref list, when there is a summary.
    summary: tailored.summary === null ? null : { ...tailored.summary, refs: firstOnly(tailored.summary.refs, (ref) => ref, "summary refs") },
    // Each section of {ref, ...} items.
    skills: firstOnly(tailored.skills, (s) => s.ref, "skills"),
    experience: firstOnly(tailored.experience, (e) => e.ref, "experience"),
    projects: firstOnly(tailored.projects, (p) => p.ref, "projects"),
    education: firstOnly(tailored.education, (e) => e.ref, "education"),
    achievements: firstOnly(tailored.achievements, (a) => a.ref, "achievements"),
    certifications: firstOnly(tailored.certifications, (c) => c.ref, "certifications"),
  };
  // A clean answer comes back unchanged in content, with nothing reported.
  return { profile, deduped };
}

/* THE SKILLS SECTION SHAPE (Teja, 2026-11-06). Three rulings, all enforced here in code:
 *   23:17 "most tailored resumes, even at 80+ ATS, have only 1 or 2 skills per group; that is not enough"
 *   23:42 "I don't need all these groups on every tailored resume" (only JD-relevant groups, aim 3-5)
 *   23:43 "make groups from master and skills for them according to the JD"
 * Measured that night: 78 of 103 groups across all 16 tailored/awaiting_approval/approved rows held 1-3
 * skills, and the median row showed 6.5 groups.
 *
 * WHY CODE AND NOT A PROMPT RULE: a model asked for "at least 4" still returns 2. So the model's answer
 * is only a hint, and the shape is decided deterministically:
 *   1. A group's RELEVANCE is how many of its master skills the posting names (keywordAppearsIn, the
 *      word-bounded rule the approval page uses, so "Go" is never credited from "Google").
 *   2. Groups shown: those with relevance > 0, ranked by relevance, then model-chosen first, then master
 *      order; at most SKILLS_MAX_GROUPS. A group the posting never touches is dropped even if the model
 *      chose it (a backend JD shows no Machine Learning group). If NO group is relevant, the model's own
 *      groups are kept: an empty skills section would be worse than an unjudged one.
 *   3. Each shown group holds the model's picks, topped up from its other master skills ranked
 *      posting-named first, then master order, to at least min(SKILLS_PER_GROUP_FLOOR, the group's master
 *      size). The floor is a MINIMUM: a group the model filled past it keeps every pick. A group smaller
 *      than the floor shows all it has: the master is the only honest source.
 *   4. ORDER (Teja, 2026-11-07, "rank by the JD"): groups in the order of step 2, and inside each group
 *      posting-named skills first, then master order. The model's own order is not kept.
 *
 * WHAT IT NEVER DOES: invent a skill (only master refs, resolved by the unchanged validator after this)
 * or hard-code a group name or size (both read from the master passed in at tailor time, the LATEST
 * version; the master grew v16 -> v17 that evening and its category names may be renamed). Runs BEFORE
 * the validator, so the stored tailor_refs re-validates to exactly the stored resume (rebuildOriginal in
 * web tailoredEdits.ts depends on that). Every ref added or dropped is reported, never silent. Exported
 * for the test. */
export const SKILLS_PER_GROUP_FLOOR = 4;
// The most groups one resume shows (Teja: "aim for 3-5").
export const SKILLS_MAX_GROUPS = 5;

// Decides the skills section; returns the profile plus the refs it added and dropped, in order.
export function shapeSkillGroups(tailored: TailoredProfile, master: MasterProfile, jobDescription: string): { readonly profile: TailoredProfile; readonly added: readonly string[]; readonly dropped: readonly string[] } {
  // Each master skill by id, so a model pick resolves to its group.
  const byId = new Map(master.skills.map((skill) => [skill.id, skill]));
  // Master categories in first-appearance order: the final tie-break, and the only source of names.
  const categories = [...new Set(master.skills.map((skill) => skill.category))];
  // Per group: how many of its master skills the posting names.
  const relevance = new Map(categories.map((category) => [category, master.skills.filter((s) => s.category === category && keywordAppearsIn(s.name, jobDescription)).length]));
  // The groups the model picked a resolvable skill in. An unresolved ref belongs to no group; it is kept
  // below so the validator still refuses it (this function must never launder a fabrication).
  const modelGroups = new Set(tailored.skills.flatMap(({ ref }) => byId.get(ref)?.category ?? []));
  // Relevant groups, best first; the sort is stable, so master order breaks the last tie.
  const relevant = categories.filter((c) => (relevance.get(c) ?? 0) > 0).sort((a, b) =>
    (relevance.get(b) ?? 0) - (relevance.get(a) ?? 0) || Number(modelGroups.has(b)) - Number(modelGroups.has(a)));
  // No relevant group at all: keep the model's groups rather than show an empty section.
  const shown = new Set((relevant.length > 0 ? relevant : [...modelGroups]).slice(0, SKILLS_MAX_GROUPS));
  // The model's picks that survive: in a shown group, or unresolved (left for the validator to refuse).
  const kept = tailored.skills.filter(({ ref }) => { const skill = byId.get(ref); return skill === undefined || shown.has(skill.category); });
  // The model's resolvable picks in a dropped group, reported.
  const dropped = tailored.skills.filter(({ ref }) => !kept.some((k) => k.ref === ref)).map(({ ref }) => ref);
  // Every ref already on the resume, so no top-up repeats one (the validator refuses duplicates).
  const present = new Set(kept.map(({ ref }) => ref));
  // The refs added, group by group in shown order.
  const added: string[] = [];
  // Each shown group, filled to its floor.
  for (const category of shown) {
    // How many the group holds already.
    const count = kept.filter(({ ref }) => byId.get(ref)?.category === category).length;
    // Its master skills not yet on the resume, in master order.
    const candidates = master.skills.filter((s) => s.category === category && !present.has(s.id));
    // The floor, capped at what the master holds for this group, minus what is there.
    const need = Math.min(SKILLS_PER_GROUP_FLOOR, count + candidates.length) - count;
    // Posting-named first; stable sort keeps master order among equals.
    const ranked = candidates.sort((a, b) => Number(keywordAppearsIn(b.name, jobDescription)) - Number(keywordAppearsIn(a.name, jobDescription)));
    // The top `need` (none when the group is already at the floor).
    for (const skill of ranked.slice(0, Math.max(0, need))) added.push(skill.id);
  }
  // Each master skill's position, the tie-break inside a group after "the posting names it".
  const masterIndex = new Map(master.skills.map((skill, index) => [skill.id, index]));
  // The kept picks and the top-ups as one pool of entries; a kept entry keeps its own object.
  const pool = [...kept, ...added.map((ref) => ({ ref }))];
  // RANKED BY THE JD (Teja, 2026-11-07, review RED 1 + the group-order yellow). The renderer groups by
  // category and orders groups by first appearance, so the order emitted here IS the page order:
  // groups in shown order (relevance first), and inside each group the skills the posting names first,
  // then master order. The model's picks get no seat ahead of a posting-named skill.
  const ordered = [...shown].flatMap((category) => pool
    // This group's resolvable entries only.
    .filter(({ ref }) => byId.get(ref)?.category === category)
    // Posting-named first; master position breaks ties, so the result never depends on the model's order.
    .sort((a, b) => Number(keywordAppearsIn(byId.get(b.ref)!.name, jobDescription)) - Number(keywordAppearsIn(byId.get(a.ref)!.name, jobDescription))
      || (masterIndex.get(a.ref) ?? 0) - (masterIndex.get(b.ref) ?? 0)));
  // Unresolved refs last, kept so the validator still refuses them (never laundered by being left out).
  const skills = [...ordered, ...kept.filter(({ ref }) => !byId.has(ref))];
  // The shaped section (an answer that already fits comes back with the same refs in the same order). A
  // reorder alone is not reported (no ref changed); added and dropped always are.
  return { profile: { ...tailored, skills }, added, dropped };
}

/* The bullets a one-shot rewrite may fix, with their untraceable words, or null for "do not retry"
 * (2026-11-05). Retry ONLY when every violation is an unverifiable_token AND sits on a bullet of this
 * profile: the rewrite only rewrites bullets, so a summary, skill, ref or metric problem would waste the
 * call and fail anyway. Exported for the test. */
export function retryableBullets(violations: readonly TailorViolation[], profile: TailoredProfile): Map<string, string[]> | null {
  // Every bullet ref in the first attempt, across every bullet-carrying section.
  const bulletRefs = new Set<string>();
  // The five sections whose nodes carry bullets.
  for (const section of [profile.experience, profile.projects, profile.education, profile.achievements, profile.certifications]) {
    // Each node's bullets, when it has any.
    for (const node of section as readonly { readonly bullets?: readonly { readonly ref: string }[] }[]) for (const b of node.bullets ?? []) bulletRefs.add(b.ref);
  }
  // Grouped by bullet, in the order reported.
  const byBullet = new Map<string, string[]>();
  // Every violation must qualify, or none is retried.
  for (const v of violations) {
    // Any other kind, or a word not on a bullet of this profile: no retry.
    if (v.kind !== "unverifiable_token" || !bulletRefs.has(v.ref)) return null;
    // The word, under its bullet.
    byBullet.set(v.ref, [...(byBullet.get(v.ref) ?? []), v.token]);
  }
  // Nothing to fix is not a retry either.
  return byBullet.size > 0 ? byBullet : null;
}

/* The master text of every bullet, by id, from every bullet-carrying section of the master. */
function masterBulletTexts(master: MasterProfile): Map<string, string> {
  // Id to text.
  const texts = new Map<string, string>();
  // The same five bullet-carrying sections, from the pinned master.
  for (const section of [master.experience, master.projects, master.education, master.achievements, master.certifications]) {
    // Each node's bullets, when it has any.
    for (const node of section as readonly { readonly bullets?: readonly { readonly id: string; readonly text: string }[] }[]) for (const b of node.bullets ?? []) texts.set(b.id, b.text);
  }
  // Complete for the pinned master.
  return texts;
}

/* The rewrite reply, validated: exactly one {ref, text} per asked bullet, no others. Null = unusable. */
function parseRewriteReply(raw: string, asked: ReadonlySet<string>): Map<string, string> | null {
  // Prose or broken JSON is unusable, not a throw: the first verdict is still a verdict.
  let parsed: unknown;
  // A parse failure is the reply's problem, recorded as reply_unusable.
  try { parsed = JSON.parse(raw); } catch { return null; }
  // The one array.
  const bullets = isRecord(parsed) && Array.isArray(parsed.bullets) ? parsed.bullets : null;
  // No array, no answer.
  if (bullets === null) return null;
  // Ref to new text.
  const out = new Map<string, string>();
  // Each entry proven before it is kept.
  for (const b of bullets) {
    // Shape, a ref that was asked for, and no ref twice.
    if (!isRecord(b) || typeof b.ref !== "string" || typeof b.text !== "string" || !asked.has(b.ref) || out.has(b.ref)) return null;
    // Kept.
    out.set(b.ref, b.text);
  }
  // Every asked bullet answered: no partial merge.
  return out.size === asked.size ? out : null;
}

/* The first attempt with exactly these bullets' text replaced; nothing else changes. */
function mergeRewrites(profile: TailoredProfile, rewrites: ReadonlyMap<string, string>): TailoredProfile {
  // One section's nodes, each node's bullets rewritten where asked.
  const rewrite = <T extends { readonly bullets?: readonly { readonly ref: string; readonly text: string }[] }>(nodes: readonly T[]): T[] =>
    // A node without bullets is returned as is.
    nodes.map((node) => (node.bullets === undefined ? node : { ...node, bullets: node.bullets.map((b) => (rewrites.has(b.ref) ? { ...b, text: rewrites.get(b.ref)! } : b)) }));
  // Every bullet-carrying section; the rest as parsed.
  return { ...profile, experience: rewrite(profile.experience), projects: rewrite(profile.projects), education: rewrite(profile.education), achievements: rewrite(profile.achievements), certifications: rewrite(profile.certifications) } as TailoredProfile;
}

// One posting in, one verdict out. Named so call sites read as a noun.
export type Tailorer = (input: TailorJobInput) => Promise<TailorOutcome>;

// Narrow `unknown` to a plain object without asserting anything about its fields.
function isRecord(value: unknown): value is Record<string, unknown> {
  // Arrays are objects to `typeof`, and null is too; both must be excluded before any
  // property access below can be trusted.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Every element of the five ref-plus-bullets sections has the same shape, so it is
// checked once here rather than five times inconsistently.
function hasRefAndBullets(value: unknown): boolean {
  // A node without a `ref` names nothing, and the validator would index `undefined`.
  if (!isRecord(value) || typeof value.ref !== "string") return false;
  // `bullets` is walked directly by the validator; a missing array crashes it.
  return Array.isArray(value.bullets);
}

// The arrays the parser refuses to go without. EXPORTED so the structural test can hold
// `TAILOR_RESPONSE_SCHEMA.required` against this exact tuple: the parser demanded the
// two award arrays while the schema never offered them, so with structured output every
// live call threw "no achievements array". One constant, read by both, ends that class.
export const TAILOR_REQUIRED_ARRAY_KEYS = [
  // Bare refs, no bullets.
  "skills",
  // Bullet-bearing parents from here down; the second parser loop walks these.
  "experience",
  // Projects.
  "projects",
  // Qualifications.
  "education",
  // Awards.
  "achievements",
  // Credentials.
  "certifications",
] as const;

// THE SHAPE CHECK, and the reason it lives in this file rather than in the validator.
//
// `validateTailoredProfile` takes a `TailoredProfile` and TRUSTS that type — it walks
// `tailored.skills` (validator.ts:489), `tailored.achievements` (:646) and
// `tailored.certifications` (:688) with no runtime guard. Types are erased at runtime,
// so handing it raw `JSON.parse` output would surface a bad model response as a
// TypeError from inside the honesty checker: our bug's stack trace for their mistake.
//
// §5's rule, applied literally: validate the SHAPE you expect. This asks "is this the
// object I was promised", never "did the parser give up".
function parseTailoredProfile(raw: string): TailoredProfile {
  // Declared outside the try so the thrown message below can stay about SHAPE, not
  // about syntax, once parsing has succeeded.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A model that returned prose has not tailored anything. Rethrown with our own
    // message because `JSON.parse`'s mentions a character offset into text the caller
    // never sees.
    throw new Error("Tailor response was not JSON");
  }

  // Everything below is a claim the validator would otherwise make on our behalf by
  // crashing. Each one is a property the validator dereferences unconditionally.
  if (!isRecord(parsed)) throw new Error("Tailor response was not a JSON object");
  // The pin the validator compares against; a non-number would compare unequal forever.
  if (typeof parsed.master_version !== "number") throw new Error("Tailor response has no numeric master_version");
  // Drives which sections render, and is iterated.
  if (!Array.isArray(parsed.section_order)) throw new Error("Tailor response has no section_order array");
  // Required arrays, possibly empty — the contract makes them required precisely so an
  // omission cannot be mistaken for a deliberate empty selection.
  // Iterates the exported tuple rather than a local list, so the structural test checks
  // the very keys this loop demands and the two cannot drift apart again.
  for (const key of TAILOR_REQUIRED_ARRAY_KEYS) {
    // Checked by name so the error says which one, rather than "malformed response".
    if (!Array.isArray(parsed[key])) throw new Error(`Tailor response has no ${key} array`);
  }
  // The five sections whose elements carry nested bullets the validator walks. `skills`
  // is excluded deliberately: a `TailoredSkill` is a bare ref with no bullets at all.
  for (const key of TAILOR_REQUIRED_ARRAY_KEYS) {
    // Skipped by name, not by a second hand-kept list that could drift from the first.
    if (key === "skills") continue;
    // `as unknown[]` is safe: the loop above already proved each of these is an array.
    if (!(parsed[key] as unknown[]).every(hasRefAndBullets)) {
      throw new Error(`Tailor response has a malformed entry in ${key}`);
    }
  }
  // Summary is nullable, so only a non-null value has a shape to check — and it is the
  // one place the model emits free prose, which the validator checks against its refs.
  // The schema leaves `summary` optional, so a schema-valid response may OMIT it — and
  // the validator dereferences any non-null summary, so `undefined` would crash it.
  // Omission and null mean the same thing here (no paragraph), so normalise to null.
  if (parsed.summary === undefined) parsed.summary = null;
  // Only a present, non-null summary has a shape left to check.
  if (parsed.summary !== null) {
    if (!isRecord(parsed.summary) || typeof parsed.summary.text !== "string" || !Array.isArray(parsed.summary.refs)) {
      throw new Error("Tailor response has a malformed summary");
    }
  }

  // THE CONTRACT VERSION. TailoredProfile declares `schema_version: 1`, but the schema sent
  // to Gemini (prompt.ts TAILOR_RESPONSE_SCHEMA) has no such property, so a live reply never
  // carries it, and the cast below used to persist tailor_refs without it. The web editor's
  // gate then refused every live row (applyyy-e8, 2026-10-08). Absent means "the version we
  // asked for", so stamp it; any OTHER value is a contract we do not speak, so refuse it
  // like every other shape failure rather than overwrite it.
  if (parsed.schema_version !== undefined && parsed.schema_version !== 1) {
    throw new Error("Tailor response has an unsupported schema_version");
  }
  // Stamped here, at the one parse boundary, so every stored tailor_refs matches its type.
  parsed.schema_version = 1;

  // Every field the validator touches has now been checked to exist and be the right
  // kind. The assertion is earned by the lines above, not assumed.
  return parsed as unknown as TailoredProfile;
}

// Build a tailorer bound to one model and one pinned master profile.
export function createTailorer(deps: TailorDeps): Tailorer {
  // Closes over the trusted inputs so each call supplies only the untrusted posting.
  return async function tailor(stored: TailorJobInput): Promise<TailorOutcome> {
    // The posting as TEXT (N1, 2026-11-07): stored rows may be raw HTML. Converted once, here, so the
    // prompt, the JD keywords and the skills shape all read the same text. postingText never returns
    // null for a string, so the non-null assertion only restores the type.
    const input: TailorJobInput = { ...stored, jobDescription: postingText(stored.jobDescription)! };

    // Assemble with the scraped fields fenced. Only the master and the pin reach the
    // instruction region; the posting goes to the untrusted region as text.
    const prompt = buildTailorPrompt({
      master: deps.master,
      masterVersion: deps.masterVersion,
      jobTitle: input.jobTitle,
      company: input.company,
      jobDescription: input.jobDescription,
    });

    // The one impure step. Everything before and after it is a pure function.
    const raw = await deps.callLlm(prompt);

    // Throws on prose or a wrong-shaped object — see the header on why that is not a
    // refusal. Deliberately before the validator, so the validator only ever sees the
    // type it was written against.
    const parsed = parseTailoredProfile(raw);

    // Repeated refs normalised away BEFORE the gate (see dedupeRepeatedRefs: normalisation, never
    // leniency). The deduplicated profile is the one validated AND the one stored, so tailor_refs
    // re-validates to exactly the stored resume.
    const { profile: deduplicated, deduped } = dedupeRepeatedRefs(parsed);

    // The skills shape (relevant groups, floor per group), after dedupe (so a repeat never counts toward a
    // group) and BEFORE the gate (so every added ref is resolved by the unchanged validator, and the stored
    // refs match the resume).
    const { profile: tailored, added: skillsAdded, dropped: skillsDropped } = shapeSkillGroups(deduplicated, deps.master, input.jobDescription);

    // The honesty gate. This is the only call in the codebase that can produce a
    // `ResolvedResume`, which is what makes "the renderer cannot resolve a ref even by
    // accident" a property of the code rather than a promise.
    const validation = validateTailoredProfile(tailored, deps.master, deps.masterVersion);

    // A refusal is DATA, not an exception: the violations are the dashboard's content
    // and the reason the row will be failed with something a human can act on.
    if (!validation.ok) {
      // The one-shot rewrite (2026-11-05), only when every violation is an untraceable word on a bullet.
      const retryable = retryableBullets(validation.violations, tailored);
      // Anything else fails exactly as before, with no extra call.
      if (retryable === null) return { kind: "refused", violations: validation.violations, retry: null };
      // Each failed bullet's master text (the only source) and its failed wording.
      const masterTexts = masterBulletTexts(deps.master);
      const firstTexts = new Map<string, string>();
      // The first attempt's wording of every bullet, by ref.
      for (const section of [tailored.experience, tailored.projects, tailored.education, tailored.achievements, tailored.certifications]) {
        // Each node's bullets, when it has any.
        for (const node of section as readonly { readonly bullets?: readonly { readonly ref: string; readonly text: string }[] }[]) for (const b of node.bullets ?? []) firstTexts.set(b.ref, b.text);
      }
      // The rewrite request: only the failed bullets.
      const items = [...retryable].map(([ref, tokens]) => ({ ref, masterText: masterTexts.get(ref) ?? "", firstText: firstTexts.get(ref) ?? "", bannedTokens: tokens }));
      // The SAME transport (key pool, fallback, usage row); a transport throw propagates exactly like the first call's.
      const reply = await deps.callLlm(buildBulletRewritePrompt(items));
      // A reply that does not answer exactly the asked bullets merges nothing.
      const rewrites = parseRewriteReply(reply, new Set(retryable.keys()));
      // Unusable: refused on the first verdict, the retry recorded as such.
      if (rewrites === null) return { kind: "refused", violations: validation.violations, retry: { firstViolations: validation.violations, result: "reply_unusable" } };
      // The whole profile, re-validated by the UNCHANGED gate: a rewrite is trusted for nothing.
      const merged = mergeRewrites(tailored, rewrites);
      // The gate, run on the whole merged profile against the same pinned master.
      const second = validateTailoredProfile(merged, deps.master, deps.masterVersion);
      // Still failing: refused, with both attempts on record.
      if (!second.ok) return { kind: "refused", violations: second.violations, retry: { firstViolations: validation.violations, result: "still_invalid" } };
      // Passed: the merged profile is what is stored, so tailor_refs re-validates to this resume.
      return { kind: "tailored", resume: second.resume, refs: merged, jdKeywords: extractJdKeywords(input.jobDescription), dedupedRefs: deduped, skillsAdded, skillsDropped, retry: { firstViolations: validation.violations, rewrittenRefs: [...rewrites.keys()] } };
    }

    // Clean. The resume is safe to persist and to hand to the Auditor, when one exists.
    // `tailored` is the parsed model output that passed validation — the refs, unresolved.
    // `jdKeywords` comes from the SAME posting the model was given, never re-read later,
    // so the keywords and the resume can never describe two different versions of a job.
    return { kind: "tailored", resume: validation.resume, refs: tailored, jdKeywords: extractJdKeywords(input.jobDescription), dedupedRefs: deduped, skillsAdded, skillsDropped, retry: null };
  };
}
