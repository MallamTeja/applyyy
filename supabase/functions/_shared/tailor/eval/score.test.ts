// Tests for the tailor golden-set scorer (tailor plan §6, 2026-11-21). SYNTHETIC fixtures only: the real eval data
// (Teja's ideals, live tailorings, chat edits) is personal and is read at runtime by scripts/tailor-golden-eval.mjs,
// never copied into the repo.
import { test } from "node:test";
// Strict, so a 0.5 never equals "0.5".
import assert from "node:assert/strict";
// The unit under test.
import { aggregate, fromIdeal, fromResolved, fromTailorRefs, scoreResume, type EvalResume } from "./score.ts";
// Types only, for the fixtures.
import type { MasterProfile, TailoredProfile } from "../../contracts/shared-types.ts";

// A tiny master: one allow-listed experience, 2 projects, 5 certifications, 2 achievements, 12 skills in 3 groups.
const MASTER = {
  schema_version: 1,
  identity: { full_name: "Test Person", headline: "Engineer", email: "t@example.com", phone: null, location: "Hyderabad", links: [] },
  summary: { id: "summary_main", text: "Engineer who builds APIs and ships them." },
  summary_variants: [{ id: "variant_backend", label: "Backend", headline: "Backend Engineer", summary: { id: "summary_backend", text: "Backend engineer who builds Python APIs on PostgreSQL. Served 40 clinics." } }],
  experience: [{ id: "exp_aczen", company: "Aczen", role: "Full Stack AI Engineer Intern", location: "Hyderabad", start_date: null, start_display: "2025", end_date: null, end_display: "2026", bullets: [{ id: "b1", text: "Built a Python API for 40 clinics.", tags: [] }] }],
  projects: ["p1", "p2", "p3"].map((id) => ({ id, name: id, links: [], start_date: null, start_display: "", end_date: null, end_display: "", bullets: [{ id: `${id}_b`, text: "Built it.", tags: [] }] })),
  education: [],
  achievements: ["a1", "a2"].map((id) => ({ id, label: id, description: null, bullets: [] })),
  certifications: ["c1", "c2", "c3", "c4", "c5"].map((id) => ({ id, label: id, description: null, bullets: [] })),
  skills: [
    ...["Python", "TypeScript", "Go"].map((name) => ({ id: `s_${name}`, name, category: "Languages" })),
    ...["RAG Pipelines", "Prompt Engineering", "LangChain", "Embeddings", "Agents"].map((name) => ({ id: `s_${name.replace(/ /g, "_")}`, name, category: "AI" })),
    ...["PostgreSQL", "Docker", "Git", "Postman"].map((name) => ({ id: `s_${name}`, name, category: "Tools" })),
  ],
} as unknown as MasterProfile;

// A job naming Python, PostgreSQL and Docker.
const JD = "Backend Engineer. You will build Python services on PostgreSQL and ship them with Docker.";

// A resume that passes every rule: built field by field so each test breaks exactly one.
function good(overrides: Partial<EvalResume> = {}): EvalResume {
  // The passing baseline.
  return {
    headline: "Backend Engineer",
    summary: "Engineer who builds Python APIs on PostgreSQL. Shipped a service used by 40 clinics.",
    skills: [
      { name: "Python", group: "Languages" }, { name: "TypeScript", group: "Languages" },
      { name: "RAG Pipelines", group: "AI" }, { name: "Prompt Engineering", group: "AI" }, { name: "LangChain", group: "AI" }, { name: "Embeddings", group: "AI" }, { name: "Agents", group: "AI" },
      { name: "PostgreSQL", group: "Databases" }, { name: "Docker", group: "DevOps" }, { name: "Git", group: "Tools" },
    ],
    projects: 2,
    certifications: 5,
    achievements: 2,
    aczenTitle: "Backend Engineer Intern",
    ...overrides,
  };
}

// The context the scorer needs: the JD, the JD title and the master.
const CTX = { jd: JD, jobTitle: "Backend Engineer", master: MASTER };

test("a resume that meets every rule scores every rule as passed", () => {
  // Scored with no target, so only the rules apply.
  const score = scoreResume(good(), CTX);
  // Every rule named, every one passed.
  assert.deepEqual(score.failedRules, []);
  // The pass rate is a fraction of the rules that apply.
  assert.equal(score.rulePassRate, 1);
  // No target: no skill comparison.
  assert.equal(score.skills, null);
});

test("each rule fails on its own, named, so a table can say what broke", () => {
  // Each case breaks one rule and names the one expected to fail.
  const cases: Array<[Partial<EvalResume>, string]> = [
    // 4 groups (< 5).
    [{ skills: good().skills.filter((s) => s.group !== "Tools") }, "groups>=5"],
    // A group of 11 (> 10, Teja's 7 + 3 cap of 2026-11-21).
    [{ skills: [...good().skills, ...["A", "B", "C", "D", "E", "F"].map((name) => ({ name, group: "AI" }))] }, "group<=10"],
    // AI group of 4 (< min(5, master's 5)).
    [{ skills: good().skills.filter((s) => s.name !== "Agents") }, "ai>=5"],
    // 4 certifications.
    [{ certifications: 4 }, "certs>=5"],
    // One achievement left out.
    [{ achievements: 1 }, "all_achievements"],
    // 3 projects.
    [{ projects: 3 }, "projects<=2"],
    // The FamPay title.
    [{ aczenTitle: "Data Analyst Intern" }, "title_allowed"],
    // A team name as the headline (checkHeadline's job).
    [{ headline: "Intern" }, "headline"],
    // No summary at all.
    [{ summary: null }, "summary_present"],
    // Four sentences.
    [{ summary: "Builds Python. On PostgreSQL. For 40 clinics. Daily." }, "summary_2_3_sentences"],
    // No JD keyword at all (calibrated 2026-11-21: >=1, since the ideals name 1 in 9 of 26 cases).
    [{ summary: "Engineer who builds web services. Shipped a service used by 40 clinics." }, "summary_jd_keyword"],
    // No number.
    [{ summary: "Engineer who builds Python APIs on PostgreSQL. Shipped services that clinics use." }, "summary_metric"],
    // A master variant word for word (case and spacing aside).
    [{ summary: "backend engineer who builds  Python APIs on PostgreSQL.  Served 40 clinics." }, "summary_not_verbatim"],
  ];
  // Each case alone.
  for (const [override, rule] of cases) {
    // Scored.
    const score = scoreResume(good(override), CTX);
    // Exactly that rule.
    assert.deepEqual(score.failedRules, [rule], rule);
  }
});

test("rules that read the job do not apply without one: no JD, no keyword rule; no job title, no headline rule", () => {
  // An ideal with no matching row has neither (7 of the 33 live ideals): a missing input is not a failure (§6).
  const score = scoreResume(good({ headline: "Platform Wizard" }), { jd: "", jobTitle: null, master: MASTER });
  // Neither job rule ran, so neither failed.
  assert.deepEqual(score.failedRules, []);
  // And they are not counted as applied: 12 rules with the job, 10 without.
  assert.equal(score.rulesApplied, scoreResume(good(), CTX).rulesApplied - 2);
});

test("skills are compared with a target by alias-folded name: precision, recall and most-needed-first order", () => {
  // The target: Postgres spelled long, Docker first, Python second, Kubernetes the resume lacks.
  const target = [{ name: "Docker", group: "Tools" }, { name: "Python", group: "Languages" }, { name: "PostgreSQL", group: "Databases" }, { name: "Kubernetes", group: "Tools" }];
  // The resume says "Postgres" (an alias), orders Python before Docker, and adds Go the target lacks.
  const resume = good({ skills: [{ name: "Python", group: "L" }, { name: "Docker", group: "T" }, { name: "Postgres", group: "D" }, { name: "Go", group: "L" }] });
  // Scored against the target.
  const score = scoreResume(resume, { ...CTX, target });
  // 3 of the resume's 4 are wanted.
  assert.equal(score.skills?.precision, 0.75);
  // 3 of the target's 4 are present (Postgres = PostgreSQL).
  assert.equal(score.skills?.recall, 0.75);
  // Common skills Python, Docker, PostgreSQL: pairs (P,D) discordant, (P,Pg) concordant, (D,Pg) concordant = 2/3.
  assert.equal(score.skills?.order, 2 / 3);
  // What is missing and what is extra, for the table.
  assert.deepEqual(score.skills?.missing, ["Kubernetes"]);
  // And the extra.
  assert.deepEqual(score.skills?.extra, ["Go"]);
});

test("order agreement is null when fewer than two skills are shared, never a fake perfect score", () => {
  // One shared skill only.
  const score = scoreResume(good({ skills: [{ name: "Python", group: "L" }] }), { ...CTX, target: [{ name: "Python", group: "L" }, { name: "Rust", group: "L" }] });
  // Nothing to order.
  assert.equal(score.skills?.order, null);
});

test("fromIdeal reads an ideal file's name-based shape", () => {
  // The ideal shape (names, not ids), synthetic.
  const ideal = { headline: "Backend Engineer", aczen_title: "Software Engineer Intern", summary: { text: "S.", sources: [] }, skills: [{ group: "AI", skills: ["RAG Pipelines", "Agents"] }, { group: "Tools", skills: ["Git"] }], projects: [{}, {}], certifications: ["c1", "c2"], achievements: ["a1"] };
  // Normalised.
  assert.deepEqual(fromIdeal(ideal), { headline: "Backend Engineer", summary: "S.", skills: [{ name: "RAG Pipelines", group: "AI" }, { name: "Agents", group: "AI" }, { name: "Git", group: "Tools" }], projects: 2, certifications: 2, achievements: 1, aczenTitle: "Software Engineer Intern" });
});

test("fromTailorRefs resolves a tailoring's refs through its own master, and the headline follows the stored precedence", () => {
  // A ref-only tailoring, as the tailor writes it: a variant picked, no headline_title, no role_title.
  const refs = {
    summary: { text: "Hi.", refs: ["b1"] }, summary_variant: "variant_backend",
    skills: [{ ref: "s_Docker" }, { ref: "s_Python" }],
    experience: [{ ref: "exp_aczen", bullets: [] }], projects: [{ ref: "p1", bullets: [] }],
    certifications: [{ ref: "c1", bullets: [] }], achievements: [{ ref: "a1", bullets: [] }, { ref: "a2", bullets: [] }],
  } as unknown as TailoredProfile;
  // Resolved.
  const resume = fromTailorRefs(refs, MASTER);
  // Skills in the tailoring's order, with the master's group.
  assert.deepEqual(resume.skills, [{ name: "Docker", group: "Tools" }, { name: "Python", group: "Languages" }]);
  // headline_title, else the picked variant's headline, else the master's (the validator's order).
  assert.equal(resume.headline, "Backend Engineer");
  // No role_title: the master's role prints.
  assert.equal(resume.aczenTitle, "Full Stack AI Engineer Intern");
  // Counts.
  assert.deepEqual([resume.projects, resume.certifications, resume.achievements], [1, 1, 2]);
  // An unknown skill ref is dropped from the resolved list, never invented as a name.
  assert.equal(fromTailorRefs({ ...refs, skills: [{ ref: "s_missing" }] } as unknown as TailoredProfile, MASTER).skills.length, 0);
});

test("fromResolved reads a stored, already-resolved tailored_profile (the post-chat state)", () => {
  // The resolved shape: skills carry name and category.
  const resolved = { identity: { headline: "AI Engineer" }, summary: "S.", skills: [{ ref: "x", name: "Git", category: "Tools" }], experience: [{ ref: "exp_aczen", role: "AI Engineer Intern" }], projects: [{}, {}], certifications: [{}], achievements: [{}, {}] };
  // Normalised.
  assert.deepEqual(fromResolved(resolved), { headline: "AI Engineer", summary: "S.", skills: [{ name: "Git", group: "Tools" }], projects: 2, certifications: 1, achievements: 2, aczenTitle: "AI Engineer Intern" });
});

test("aggregate averages what applies and counts each rule's failures", () => {
  // Two scores: one perfect, one failing two rules, with skills compared.
  const a = scoreResume(good(), { ...CTX, target: [{ name: "Python", group: "L" }] });
  // The second.
  const b = scoreResume(good({ projects: 3, certifications: 4 }), { ...CTX, target: [{ name: "Rust", group: "L" }] });
  // Aggregated.
  const agg = aggregate([a, b]);
  // Two resumes.
  assert.equal(agg.n, 2);
  // Recall 1 and 0.
  assert.equal(agg.meanRecall, 0.5);
  // Each rule's failure count.
  assert.deepEqual(agg.ruleFailures, { "certs>=5": 1, "projects<=2": 1 });
  // A resume passes only with every rule passed.
  assert.equal(agg.allRulesPassRate, 0.5);
});
