// fitTailoredToOnePage: the tailor's one-page step (Teja, 2026-11-07), with the REAL fitsOnePage.
// What it must guarantee: the stored refs re-validate to exactly the stored (trimmed) resume, a
// trim is never silent, and a resume that cannot fit at its floors is refused, not stored.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ResolvedResume, TailoredProfile } from "../contracts/shared-types.ts";
import { fitTailoredToOnePage } from "./tailorer.ts";
import { fitsOnePage } from "../../../../packages/resume-template/src/index.ts";
// The template package's committed synthetic fixture: no real person's data.
import { zomatoBackendIntern } from "../../../../packages/resume-template/test/fixtures/zomato-backend-intern.ts";

/** The fixture with `extra` long bullets spread over its experience and project entries. */
function grown(extra: number): ResolvedResume {
  // A deep copy per call.
  const resume = structuredClone(zomatoBackendIntern) as unknown as ResolvedResume;
  // Entries that take bullets.
  const targets = [...resume.experience, ...resume.projects];
  // Round-robin.
  for (let i = 0; i < extra; i += 1) {
    // A long bullet, unique per i so refs and text differ.
    const text = `Built and operated service number ${i} handling queues, caching, retries and dashboards for several internal teams across regions.`;
    // Appended like any tailored bullet.
    (targets[i % targets.length]!.bullets as { ref: string; text: string; master_text: string }[]).push({ ref: `syn_${i}`, text, master_text: text });
  }
  // The grown resume.
  return resume;
}

/** The ref profile a resolved resume came from (bullets carry their printed text). */
function refsOf(r: ResolvedResume): TailoredProfile {
  // Each entry reduced to ref + bullets.
  const entries = (list: readonly { ref: string; bullets: readonly { ref: string; text: string }[] }[]) => list.map((e) => ({ ref: e.ref, bullets: e.bullets.map((b) => ({ ref: b.ref, text: b.text })) }));
  // The ref shape.
  return {
    schema_version: 1, master_version: r.master_version, section_order: r.section_order, summary: null,
    skills: r.skills.map((s) => ({ ref: s.ref })), experience: entries(r.experience), projects: entries(r.projects),
    education: entries(r.education), achievements: entries(r.achievements), certifications: entries(r.certifications),
  } as TailoredProfile;
}

/** A stand-in validator: the full resume, filtered to whatever the refs still hold. */
function validatorFor(full: ResolvedResume): (refs: TailoredProfile) => ResolvedResume {
  // Every ref the profile still names.
  return (refs) => {
    // Bullet refs kept.
    const keep = new Set([...refs.experience, ...refs.projects, ...refs.education, ...refs.achievements, ...refs.certifications].flatMap((e) => e.bullets.map((b) => b.ref)));
    // Certification entries kept.
    const certs = new Set(refs.certifications.map((c) => c.ref));
    // Filter one section's bullets.
    const f = <T extends { bullets: readonly { ref: string }[] }>(list: readonly T[]): T[] => list.map((e) => ({ ...e, bullets: e.bullets.filter((b) => keep.has(b.ref)) }));
    // The resolved resume, as the real validator would rebuild it.
    return { ...full, experience: f(full.experience), projects: f(full.projects), achievements: f(full.achievements), certifications: f(full.certifications.filter((c) => certs.has(c.ref))) };
  };
}

test("an over-one-page tailoring is trimmed to fit, and its refs re-validate to exactly the stored resume", () => {
  // Over one page even at the minimum typography (precondition, so the test is not vacuous).
  const full = grown(30);
  // Precondition.
  assert.equal(fitsOnePage(full), false);
  // The step.
  const out = fitTailoredToOnePage(refsOf(full), full, ["caching"], validatorFor(full));
  // Fits now.
  assert.equal(out.kind, "fits");
  // Narrowed.
  if (out.kind !== "fits") return;
  // Really one page by the renderer's own model.
  assert.equal(fitsOnePage(out.resume), true);
  // Something was trimmed, and it is listed.
  assert.ok(out.trimmed.length > 0);
  // The stored refs resolve to exactly the stored resume.
  assert.deepEqual(validatorFor(full)(out.refs), out.resume);
  // Skills are untouched.
  assert.deepEqual(out.resume.skills, full.skills);
});

test("a re-validation that disagrees with the trim fails closed (page_overflow), never stores a mismatch", () => {
  // Over a page.
  const full = grown(30);
  // A validator that ignores the trim (returns the untrimmed resume).
  const out = fitTailoredToOnePage(refsOf(full), full, [], () => full);
  // Refused, with the reason.
  assert.deepEqual(out, { kind: "overflow", violation: { kind: "page_overflow", blockedBy: ["trimmed refs did not re-validate to the trimmed resume"] } });
});

test("a resume over one page at every floor is refused with the floors named", () => {
  // A summary is never trimmed, so a very long one cannot be fitted by removing bullets.
  // (The fixture lists no summary section, so it is added to section_order or it would never print.)
  const base = grown(0);
  // The long summary, printed first.
  const full = { ...base, section_order: ["summary", ...base.section_order], summary: "Long summary sentence about systems. ".repeat(400) } as ResolvedResume;
  // The step.
  const out = fitTailoredToOnePage(refsOf(full), full, [], validatorFor(full));
  // Refused.
  assert.equal(out.kind, "overflow");
  // The violation names the summary floor.
  assert.ok(out.kind === "overflow" && out.violation.kind === "page_overflow" && out.violation.blockedBy.includes("summary: never removed"));
});

test("a resume that already fits passes through unchanged (same objects, nothing trimmed)", () => {
  // The fixture as committed fits one page.
  const full = grown(0);
  // Its refs.
  const refs = refsOf(full);
  // The step.
  const out = fitTailoredToOnePage(refs, full, [], validatorFor(full));
  // Same objects back, nothing trimmed.
  assert.ok(out.kind === "fits" && out.refs === refs && out.resume === full && out.trimmed.length === 0);
});

// --- AI group (2026-11-10, Teja): every tailored resume carries >= 5 AI skills (master category exactly "AI"),
// ranked by JD relevance and protected like the >= 5 certifications. These drive the WHOLE createTailorer pipeline
// (parse -> shape -> content rules -> validate -> page fit -> content check), because the ruling is about what is
// STORED, and a unit test of one step would pass while a later step drops the group again.

// The full pipeline, imported here (not at the top) so the existing tests' imports stay exactly as they were.
import { createTailorer } from "./tailorer.ts";
// The master type, from the contract owner, so the fixture below drifts into a compile error, not a silent pass.
import type { MasterProfile } from "../contracts/shared-types.ts";

// The pinned master version both fixtures resolve against; a literal so no test can nudge it.
const AI_MASTER_VERSION = 11;

// Eight master AI skills: more than the floor of 5, so "min(5, master AI count)" is 5 and a top-up has a choice.
const AI_SKILLS = ["LLM Agents", "RAG", "Prompt Engineering", "LangChain", "Vector Databases", "Fine-tuning", "Embeddings", "Model Evaluation"]
  // One skill per name, category EXACTLY "AI" (the ruling keys on that string, not on "Machine Learning").
  .map((name, i) => ({ id: `ai_${i}`, name, category: "AI" }));

/** The master experience's bullets: `n` long, distinct lines, so the page fit has bullets to take. */
function masterBullets(n: number): { id: string; text: string; tags: string[] }[] {
  // One long bullet per index; distinct text so refs, ranking and traceability never collide.
  return Array.from({ length: n }, (_, i) => ({ id: `bul_${i}`, text: `Built and operated backend service number ${i} handling queues, caching, retries and dashboards for several internal teams across regions.`, tags: [] }));
}

/** A master with one experience of `bullets` bullets, three backend skill groups and the eight AI skills. */
function aiMaster(bullets: number): MasterProfile {
  // No projects, certifications, achievements or education: every content floor is min(rule, 0) = 0, so the
  // ONLY rule this fixture can break is the AI group (the brief: the missing AI group must be the sole failure).
  return {
    // Shape marker from the schema owner.
    schema_version: 1,
    // Copied verbatim into the resume; never tailored.
    identity: { full_name: "Synthetic Candidate", headline: "Backend Engineer", email: "candidate@example.com", phone: null, location: "Hyderabad", links: [] },
    // Null: no summary floor applies (checkContentRules requires one only when the master holds one).
    summary: null,
    // Empty: the education floor is min(2, 0) = 0.
    education: [],
    // The one substantive node: the validator refuses a tailoring with no experience, project or education.
    experience: [{ id: "exp_backend", company: "Synthetic Co", role: "Backend Intern", location: "Hyderabad", start_display: "Jun 2025", end_display: "Aug 2025", start_date: null, end_date: null, bullets: masterBullets(bullets) }],
    // Empty: the project count floor is min(2, 0) = 0.
    projects: [],
    // Three backend groups the JD names (so the shape has its three relevant groups without reaching for AI),
    // then the AI group, which the backend JD never names.
    skills: [
      // Languages: named by the posting.
      { id: "lang_node", name: "Node.js", category: "Languages" },
      // Languages: named by the posting.
      { id: "lang_sql", name: "SQL", category: "Languages" },
      // Languages: named by the posting.
      { id: "lang_ts", name: "TypeScript", category: "Languages" },
      // DevOps: named by the posting.
      { id: "dev_docker", name: "Docker", category: "DevOps" },
      // DevOps: named by the posting.
      { id: "dev_k8s", name: "Kubernetes", category: "DevOps" },
      // Databases: named by the posting.
      { id: "db_postgres", name: "PostgreSQL", category: "Databases" },
      // Databases: named by the posting.
      { id: "db_redis", name: "Redis", category: "Databases" },
      // The AI group, eight strong.
      ...AI_SKILLS,
    ],
    // Empty: the achievements floor is min(Infinity, 0) = 0.
    achievements: [],
    // Empty: the certifications floor is min(5, 0) = 0.
    certifications: [],
    // No profile links.
    links: [],
  } as MasterProfile;
}

// A NON-AI backend posting: it names the backend groups and no AI skill, so JD relevance alone never adds one.
const AI_BACKEND_POSTING = { jobTitle: "Backend Engineer Intern", company: "Acme Corp", jobDescription: "Backend role: SQL, TypeScript and Node.js services on PostgreSQL and Redis, shipped with Docker and Kubernetes." };

/** Runs the real tailorer: the model cites `cited` master bullets verbatim and ONLY backend skills, zero AI refs. */
async function aiOutcome(masterBulletCount: number, cited: number) {
  // The master the pipeline is pinned to.
  const master = aiMaster(masterBulletCount);
  // The model's answer: verbatim master text (so the honesty gate passes) and no AI skill ref at all.
  const answer = {
    // The only schema version the parser accepts.
    schema_version: 1,
    // Echoes the pin, or the validator refuses it as stale.
    master_version: AI_MASTER_VERSION,
    // Skills and experience print; nothing else is cited.
    section_order: ["skills", "experience"],
    // No summary: the master holds none.
    summary: null,
    // Backend picks only: the case the ruling exists for (the model "forgot" the AI group).
    skills: [{ ref: "lang_node" }, { ref: "lang_sql" }, { ref: "dev_docker" }, { ref: "db_postgres" }],
    // The first `cited` master bullets, verbatim.
    experience: [{ ref: "exp_backend", bullets: master.experience[0]!.bullets.slice(0, cited).map((b) => ({ ref: b.id, text: b.text })) }],
    // Nothing else cited.
    projects: [], education: [], achievements: [], certifications: [],
  };
  // The real runner, with a fake model that returns exactly that answer.
  const tailor = createTailorer({ callLlm: () => Promise.resolve(JSON.stringify(answer)), master, masterVersion: AI_MASTER_VERSION });
  // The outcome, as production would store or refuse it.
  return await tailor(AI_BACKEND_POSTING);
}

/** How many printed skills sit in the AI group. */
function aiCount(resume: { readonly skills: readonly { readonly category: string }[] }): number {
  // Exactly "AI": the ruling's category string.
  return resume.skills.filter((s) => s.category === "AI").length;
}

test("AI group (2026-11-10): a model answer with no AI skill still stores >= 5 AI skills on a backend JD", async () => {
  // Four bullets: well inside one page, so the page fit is not a factor here.
  const outcome = await aiOutcome(4, 4);
  // Tailored, not refused: if this fails, the message carries the refusal so the fixture can be fixed.
  assert.equal(outcome.kind, "tailored", JSON.stringify(outcome));
  // Narrowed.
  if (outcome.kind !== "tailored") return;
  // THE RULING: min(5, 8) = 5 AI skills on the stored resume, though the model picked none and the JD names none.
  assert.ok(aiCount(outcome.resume) >= 5, `AI skills on the stored resume: ${aiCount(outcome.resume)}, needs 5`);
});

test("AI group (2026-11-10): on a page tight enough to trim, the fit takes bullets and the >= 5 AI skills survive", async () => {
  // Thirty long cited bullets on one experience: over one page, so fitToOnePage must trim (floor is 1 bullet).
  const outcome = await aiOutcome(30, 30);
  // Tailored, not refused (the experience floor of 1 bullet leaves plenty of room to fit).
  assert.equal(outcome.kind, "tailored", JSON.stringify(outcome));
  // Narrowed.
  if (outcome.kind !== "tailored") return;
  // The fit really ran: something was trimmed (a non-empty list), or the fixture no longer forces a trim.
  assert.ok(outcome.pageFitTrimmed.length > 0, "the page fit trimmed nothing: the fixture no longer forces a trim");
  // Fewer bullets than cited: the trim took BULLETS.
  assert.ok(outcome.resume.experience[0]!.bullets.length < 30);
  // No trimmed item names an AI skill ref: the AI group is protected, only bullets go.
  assert.ok(outcome.pageFitTrimmed.every((t) => !JSON.stringify(t).includes("ai_")), JSON.stringify(outcome.pageFitTrimmed));
  // THE RULING, after the trim: still min(5, 8) = 5 AI skills.
  assert.ok(aiCount(outcome.resume) >= 5, `AI skills on the stored resume after the page fit: ${aiCount(outcome.resume)}, needs 5`);
});
