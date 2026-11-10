/**
 * The content rules (Teja, 2026-11-08 15:36 + 15:46 IST): exactly min(2, master) projects each with
 * 3-4 bullets (selected at 4, gated at 3 since T7 2026-11-10), Aczen >= 4 bullets, certifications >= 5 and EVERY achievement (2026-11-09 20:41 IST; were 3 and 2),
 * education >= 2, each capped at what the master holds; and the
 * cited-summary-variant seam (LSEG 2b7db9a2). Each rule's test is named after the rule, and the
 * tailorer tests run the REAL createTailorer + validator + page fit, so reverting the one call in
 * tailorer.ts turns them red.
 */
// Strict asserts: deepEqual compares by structure and type.
import assert from "node:assert/strict";
// The runner the whole functions suite uses.
import { test } from "node:test";
// The module under test.
import { checkContentRules, cleanRoleTitle, enforceContentRules, pickCitedVariant } from "./content-rules.ts";
// The real tailorer, so the integration tests exercise the shipped wiring.
import { createTailorer } from "./tailorer.ts";
// The real gate, to prove every top-up resolves.
import { validateTailoredProfile } from "./validator.ts";
// Types only.
import type { MasterProfile, TailoredProfile } from "../contracts/shared-types.ts";

// The pin every profile echoes.
const VERSION = 25;

/** A master bullet whose text carries the given words. */
const mb = (id: string, text: string) => ({ id, text, tags: [] as string[] });

/** A master shaped like live v25: 3 projects (4/3/5 bullets here; one short of the 4-bullet rule), Aczen 5, 3 certs, 3 achievements, 2 educations. */
function master(): MasterProfile {
  // Every array the validator indexes is present, so a failure means the rule, not a missing field.
  return {
    schema_version: 1,
    identity: { full_name: "Teja Mallam", headline: "Software Engineer", email: "tejamallam00@gmail.com", phone: null, location: "Hyderabad", links: [] },
    summary: null,
    summary_variants: [
      // Two variants, so "exactly one cited" and "several cited" are both testable.
      { id: "variant-ai", label: "AI", headline: "AI Engineer", summary: { id: "summary-ai", text: "Engineer building LLM features with TypeScript." } },
      { id: "variant-web", label: "Web", headline: "Full-stack Engineer", summary: { id: "summary-web", text: "Engineer building web apps with React." } },
    ],
    education: [
      { id: "edu_mlrit", institution: "MLRIT", degree: "B.Tech", field: "CSE", start_display: "2021", end_display: "2025", start_date: null, end_date: null, grade_display: null, bullets: [] },
      { id: "edu_diploma", institution: "TKR", degree: "Diploma", field: "ECE", start_display: "2018", end_display: "2021", start_date: null, end_date: null, grade_display: null, bullets: [] },
    ],
    experience: [{
      id: "exp_aczen", company: "Aczen", role: "Software Engineer Intern", location: "Hyderabad", start_display: "Jan 2025", end_display: "Jun 2025", start_date: null, end_date: null,
      // Five bullets; two name the posting's keywords so the top-up order is observable.
      bullets: [mb("az1", "Built ledger APIs in Node.js"), mb("az2", "Wrote reconciliation jobs in TypeScript and PostgreSQL"), mb("az3", "Ran weekly demos for finance teams"), mb("az4", "Set up PostgreSQL migrations"), mb("az5", "Documented onboarding steps")],
    }],
    projects: [
      // Eligible (4 bullets), weakly relevant.
      { id: "proj_one", name: "One on One", links: [], start_display: "2025", end_display: "2025", start_date: null, end_date: null, bullets: [mb("o1", "Built a mentoring app"), mb("o2", "Added chat"), mb("o3", "Added scheduling"), mb("o4", "Deployed it")] },
      // NOT eligible (3 bullets in the master), but the most relevant: the rule still prefers eligible ones.
      { id: "proj_f1", name: "F1 Predictor", links: [], start_display: "2024", end_display: "2024", start_date: null, end_date: null, bullets: [mb("f1", "Trained TypeScript PostgreSQL Node.js models"), mb("f2", "Scraped TypeScript data"), mb("f3", "Plotted PostgreSQL results")] },
      // Eligible, relevant.
      { id: "proj_applyy", name: "Applyy", links: [], start_display: "2026", end_display: "2026", start_date: null, end_date: null, bullets: [mb("y1", "Built a job pipeline in TypeScript"), mb("y2", "Stored rows in PostgreSQL"), mb("y3", "Ran agents on Node.js"), mb("y4", "Added an approval queue"), mb("y5", "Wrote tests")] },
    ],
    skills: [{ id: "skill-ts", name: "TypeScript", category: "Languages" }, { id: "skill-pg", name: "PostgreSQL", category: "Databases" }],
    achievements: [
      { id: "ach_a", label: "Hackathon winner", description: null, bullets: [mb("aa1", "Won with a TypeScript bot")] },
      { id: "ach_b", label: "Dean's list", description: null, bullets: [mb("ab1", "Top 5 percent")] },
      { id: "ach_c", label: "Open source", description: null, bullets: [mb("ac1", "Merged PRs")] },
    ],
    certifications: [
      { id: "cert_sql", label: "PostgreSQL Associate", description: null, bullets: [] },
      { id: "cert_ml", label: "Machine Learning", description: null, bullets: [] },
      { id: "cert_cloud", label: "Cloud Practitioner", description: null, bullets: [] },
    ],
    links: [],
  } as unknown as MasterProfile;
}

/** The model's answer at its worst: 3 projects, 1 Aczen bullet, no certifications, 1 achievement, 1 education. */
function greedyAnswer(): TailoredProfile {
  // Every bullet is master text verbatim, so the validator passes it and only the content rules can object.
  return {
    schema_version: 1,
    master_version: VERSION,
    section_order: ["skills", "experience", "projects", "education", "achievements"],
    summary: null,
    skills: [{ ref: "skill-ts" }, { ref: "skill-pg" }],
    experience: [{ ref: "exp_aczen", bullets: [{ ref: "az1", text: "Built ledger APIs in Node.js" }] }],
    projects: [
      { ref: "proj_f1", bullets: [{ ref: "f1", text: "Trained TypeScript PostgreSQL Node.js models" }] },
      { ref: "proj_one", bullets: [{ ref: "o1", text: "Built a mentoring app" }] },
      { ref: "proj_applyy", bullets: [{ ref: "y1", text: "Built a job pipeline in TypeScript" }] },
    ],
    education: [{ ref: "edu_mlrit", bullets: [] }],
    achievements: [{ ref: "ach_c", bullets: [{ ref: "ac1", text: "Merged PRs" }] }],
    certifications: [],
  } as unknown as TailoredProfile;
}

// The posting's keywords for the pure tests.
const JD = ["TypeScript", "PostgreSQL"];

test("tailored resume never keeps 3 projects: exactly 2, the >= 4-bullet ones first", () => {
  // The model picked all three.
  const { profile, changes } = enforceContentRules(greedyAnswer(), master(), JD);
  // Two kept, in the model's order: f1 (3 master bullets) lost to the two eligible projects.
  assert.deepEqual(profile.projects.map((p) => p.ref), ["proj_one", "proj_applyy"]);
  // The drop is recorded, never silent.
  assert.ok(changes.some((c) => c.change === "dropped" && c.ref === "proj_f1"));
});

/** The master with a 4th project, proj_x: eligible (4 bullets) and the MOST JD-relevant, so applyy would lose on relevance. */
function masterWithStrongRival(): MasterProfile {
  // The base master.
  const base = master();
  // A rival naming both JD keywords in every bullet.
  const rival = { ...base.projects[0]!, id: "proj_x", name: "TypeScript PostgreSQL platform", bullets: [mb("x1", "TypeScript PostgreSQL"), mb("x2", "TypeScript PostgreSQL"), mb("x3", "TypeScript PostgreSQL"), mb("x4", "TypeScript PostgreSQL")] };
  // proj_one made relevant too, so both rivals outrank applyy on score.
  const one = { ...base.projects[0]!, bullets: base.projects[0]!.bullets.map((b) => ({ ...b, text: `${b.text} TypeScript PostgreSQL` })) };
  // Order: the rivals first, applyy last (master order is the final tie-break, so it cannot help applyy).
  return { ...base, projects: [rival, one, base.projects[1]!, base.projects[2]!] } as MasterProfile;
}

test("applyy is always one of the 2 projects", () => {
  // The model picked the two strongest rivals and not applyy.
  const answer = { ...greedyAnswer(), projects: [{ ref: "proj_x", bullets: [{ ref: "x1", text: "TypeScript PostgreSQL" }] }, { ref: "proj_one", bullets: [{ ref: "o1", text: "Built a mentoring app TypeScript PostgreSQL" }] }] } as unknown as TailoredProfile;
  // Enforced against the master where applyy loses on every other criterion.
  const { profile, changes } = enforceContentRules(answer, masterWithStrongRival(), JD);
  // Applyy holds a slot; the other is the model's first pick (proj_x: chosen, eligible, highest score).
  assert.deepEqual(profile.projects.map((p) => p.ref).sort(), ["proj_applyy", "proj_x"]);
  // The displaced pick and the added applyy are both recorded.
  assert.ok(changes.some((c) => c.change === "dropped" && c.ref === "proj_one") && changes.some((c) => c.change === "added" && c.ref === "proj_applyy"));
});

test("a master without proj_applyy still picks 2 by relevance", () => {
  // The same strong-rival master with applyy removed.
  const noApplyy = { ...masterWithStrongRival(), projects: masterWithStrongRival().projects.filter((p) => p.id !== "proj_applyy") } as MasterProfile;
  // The greedy answer minus applyy.
  const answer = { ...greedyAnswer(), projects: greedyAnswer().projects.filter((p) => p.ref !== "proj_applyy") } as unknown as TailoredProfile;
  // Enforced.
  const { profile } = enforceContentRules(answer, noApplyy, JD);
  // The two eligible ones (proj_one picked; proj_x most relevant); f1 (3 bullets) loses as before.
  assert.deepEqual(profile.projects.map((p) => p.ref).sort(), ["proj_one", "proj_x"]);
});

test("each kept project is topped up to 4 bullets from master text, most JD-relevant first", () => {
  // Enforced.
  const { profile } = enforceContentRules(greedyAnswer(), master(), JD);
  // Applyy: the model's y1, then y2 (names PostgreSQL), then the zero-score y3, y4 in master order.
  assert.deepEqual(profile.projects.find((p) => p.ref === "proj_applyy")!.bullets.map((b) => b.ref), ["y1", "y2", "y3", "y4"]);
  // Every top-up is the master's own text, so nothing is invented.
  assert.deepEqual(profile.projects.find((p) => p.ref === "proj_one")!.bullets.map((b) => b.text), ["Built a mentoring app", "Added chat", "Added scheduling", "Deployed it"]);
});

test("tailor tops up Aczen to 4 bullets when the model picks 1", () => {
  // Enforced.
  const { profile } = enforceContentRules(greedyAnswer(), master(), JD);
  // The model's az1, then the keyword bullets az2 (2) and az4 (1), then az3 by master order.
  assert.deepEqual(profile.experience.find((e) => e.ref === "exp_aczen")!.bullets.map((b) => b.ref), ["az1", "az2", "az4", "az3"]);
});

test("certifications topped up to min(5, master) = 3, EVERY achievement, education to 2, and their sections printed", () => {
  // Enforced.
  const { profile } = enforceContentRules(greedyAnswer(), master(), JD);
  // All three master certifications: the master holds only 3, so a 3-cert master still tailors (never padded).
  assert.equal(profile.certifications.length, 3);
  // The model's achievement, then EVERY missing one, most relevant first (ach_a names TypeScript), master order on a tie.
  assert.deepEqual(profile.achievements.map((a) => a.ref), ["ach_c", "ach_a", "ach_b"]);
  // Both educations; the diploma counts.
  assert.deepEqual(profile.education.map((e) => e.ref), ["edu_mlrit", "edu_diploma"]);
  // The model left certifications out of section_order; an added section must print.
  assert.ok(profile.section_order.includes("certifications"));
});

test("a 6-certification master gets exactly 5 certifications (the 2026-11-09 floor), and the gate names the 5", () => {
  // Teja's master after his additions, plus one more: 6 certifications.
  const six = { ...master(), certifications: [...master().certifications, ...["cert_aws", "cert_gcp", "cert_k8s"].map((id) => ({ id, label: id, description: null, bullets: [] }))] } as MasterProfile;
  // Enforced on the answer that chose none.
  const { profile } = enforceContentRules(greedyAnswer(), six, JD);
  // Topped up to the floor of 5, not to all 6: the floor is a minimum, not "copy the section".
  assert.equal(profile.certifications.length, 5);
  // And the gate on the un-enforced answer names the floor of 5 (min(5, 6)).
  const verdict = validateTailoredProfile(greedyAnswer(), six, VERSION);
  // Honest, so it resolves.
  assert.equal(verdict.ok, true);
  // The count rule, by name.
  if (verdict.ok) assert.ok(checkContentRules(verdict.resume, six).includes("certifications: 0, needs 5"));
});

test("a short master is never padded: the floor binds at what the master holds", () => {
  // A master with ONE project of 2 bullets and ONE certification.
  const short = { ...master(), projects: [{ ...master().projects[0]!, bullets: master().projects[0]!.bullets.slice(0, 2) }], certifications: master().certifications.slice(0, 1) } as MasterProfile;
  // The model picked that project with one bullet.
  const answer = { ...greedyAnswer(), projects: [{ ref: "proj_one", bullets: [{ ref: "o1", text: "Built a mentoring app" }] }] } as unknown as TailoredProfile;
  // Enforced.
  const { profile } = enforceContentRules(answer, short, JD);
  // One project, with the 2 bullets the master holds, and the one certification it holds.
  assert.deepEqual([profile.projects.length, profile.projects[0]!.bullets.length, profile.certifications.length], [1, 2, 1]);
});

test("a compliant answer is returned as the same object, with nothing recorded", () => {
  // First make it compliant.
  const compliant = enforceContentRules(greedyAnswer(), master(), JD).profile;
  // Enforced again.
  const again = enforceContentRules(compliant, master(), JD);
  // Untouched.
  assert.deepEqual([again.profile === compliant, again.changes.length], [true, 0]);
});

test("every enforced ref resolves through the unchanged validator, and the gate then passes", () => {
  // Enforced.
  const { profile } = enforceContentRules(greedyAnswer(), master(), JD);
  // The real honesty gate.
  const verdict = validateTailoredProfile(profile, master(), VERSION);
  // Accepted: every top-up is master text.
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  // And the content gate is satisfied.
  if (verdict.ok) assert.deepEqual(checkContentRules(verdict.resume, master()), []);
});

test("checkContentRules accepts a project trimmed to 3 bullets and refuses 2", () => {
  // A compliant profile: applyy topped up to 4 (y1..y4) from a 5-bullet master, so the master can supply 4.
  const { profile } = enforceContentRules(greedyAnswer(), master(), JD);
  // The same profile with applyy cut to its first n bullets, as the trimmer's last step does to fit one page (T7).
  const withApplyyBullets = (n: number) => ({ ...profile, projects: profile.projects.map((p) => (p.ref === "proj_applyy" ? { ...p, bullets: p.bullets.slice(0, n) } : p)) }) as TailoredProfile;
  // Resolved through the real validator, then gated: the gate runs on the resolved resume, after the page fit.
  const gate = (n: number) => {
    // Honest (every bullet is master text), so it resolves.
    const verdict = validateTailoredProfile(withApplyyBullets(n), master(), VERSION);
    // A refusal here would be a fixture bug, not the rule under test.
    assert.equal(verdict.ok, true, JSON.stringify(verdict));
    // The broken list, or a marker that cannot match when the validator refused.
    return verdict.ok ? checkContentRules(verdict.resume, master()) : ["<unresolved>"];
  };
  // 3 bullets is Teja's 3-4 rule at its floor: nothing broken at all.
  assert.deepEqual(gate(3), []);
  // 2 bullets is under it: exactly one break, naming the 3 floor (not the 4 selection target).
  assert.deepEqual(gate(2), ["proj_applyy: 2 bullets, needs 3"]);
});

test("checkContentRules names 3 projects and every floor broken", () => {
  // The greedy answer, resolved without enforcement.
  const verdict = validateTailoredProfile(greedyAnswer(), master(), VERSION);
  // It is honest, so it resolves.
  assert.equal(verdict.ok, true);
  // Every rule it breaks, by name.
  if (verdict.ok) {
    // The list.
    const broken = checkContentRules(verdict.resume, master());
    // The project cap.
    assert.ok(broken.includes("projects: 3, at most 2"), broken.join("; "));
    // The Aczen floor.
    assert.ok(broken.includes("exp_aczen: 1 bullets, needs 4"));
    // The counts.
    // Certifications min(5, 3 held); achievements ALL 3 held (2026-11-09); education 2.
    assert.ok(broken.includes("certifications: 0, needs 3") && broken.includes("achievements: 1, needs 3") && broken.includes("education: 1, needs 2"), broken.join("; "));
  }
});

test("pickCitedVariant: exactly one cited variant is picked; several or a disagreeing pick are left for the validator", () => {
  // A summary citing the AI variant's paragraph, no variant picked (LSEG 2b7db9a2).
  const one = { ...greedyAnswer(), summary: { text: "Engineer building LLM features.", refs: ["summary-ai"] }, summary_variant: null } as unknown as TailoredProfile;
  // Picked.
  assert.equal(pickCitedVariant(one, master()).summary_variant, "variant-ai");
  // Both variants cited: ambiguous, unchanged (the validator refuses the unpicked citation).
  const two = { ...one, summary: { text: "x", refs: ["summary-ai", "summary-web"] } } as unknown as TailoredProfile;
  // Same object back.
  assert.equal(pickCitedVariant(two, master()), two);
  // A picked variant that disagrees with the citation: unchanged, so the validator refuses it.
  const disagree = { ...one, summary_variant: "variant-web" } as unknown as TailoredProfile;
  // Same object back.
  assert.equal(pickCitedVariant(disagree, master()), disagree);
  // And the validator does refuse the disagreeing pair (fail closed).
  assert.equal(validateTailoredProfile(disagree, master(), VERSION).ok, false);
});

// The tailorer, fed a fixed model reply: the real wiring from reply to stored resume.
const tailorerReplying = (reply: TailoredProfile) => createTailorer({ callLlm: () => Promise.resolve(JSON.stringify(reply)), master: master(), masterVersion: VERSION });
// A posting naming the keywords the ranking uses.
const POSTING = { jobTitle: "Software Engineer", company: "Acme", jobDescription: "We use TypeScript and PostgreSQL on Node.js." };

test("tailor never emits 3 projects", async () => {
  // The model returns 3 projects.
  const outcome = await tailorerReplying(greedyAnswer())(POSTING);
  // Stored, not refused: the cap is a repair, recorded.
  assert.equal(outcome.kind, "tailored", JSON.stringify(outcome));
  // Exactly 2 in the stored resume AND in the stored refs (so the rebuild matches).
  if (outcome.kind === "tailored") assert.deepEqual([outcome.resume.projects.length, outcome.refs.projects.length], [2, 2]);
});

test("tailor stores every floor met and the changes recorded", async () => {
  // The worst answer.
  const outcome = await tailorerReplying(greedyAnswer())(POSTING);
  // Stored.
  assert.equal(outcome.kind, "tailored");
  // Compliant, and the repairs are on the outcome for the event.
  if (outcome.kind === "tailored") assert.deepEqual([checkContentRules(outcome.resume, master()), outcome.contentRuleChanges.length > 0], [[], true]);
});

test("an uncited model summary is replaced by the owner's cited paragraph, not refused (2026-11-09 drain, 9 rows)", async () => {
  // The live failure: the model wrote its own paragraph and cited nothing (summary_without_refs on 060162ca and 8 more).
  const reply = { ...greedyAnswer(), section_order: ["summary", ...greedyAnswer().section_order], summary: { text: "Engineer who ships full-stack products.", refs: [] } } as unknown as TailoredProfile;
  // Through the real tailorer, so the repair and the validator both run.
  const outcome = await tailorerReplying(reply)(POSTING);
  // Stored, not refused.
  assert.equal(outcome.kind, "tailored", JSON.stringify(outcome));
  // The owner's own variant paragraph, cited by its id; the uncited text is gone from the stored refs.
  if (outcome.kind === "tailored") assert.deepEqual(outcome.refs.summary, { text: "Engineer building LLM features with TypeScript.", refs: ["summary-ai"] });
});

test("with no owner summary at all, an uncited model summary is dropped, never kept", () => {
  // A master with neither variants nor its own summary: there is no owner text to put in its place.
  const bare = { ...master(), summary: null, summary_variants: [] } as unknown as MasterProfile;
  // The uncited reply.
  const reply = { ...greedyAnswer(), section_order: ["summary", ...greedyAnswer().section_order], summary: { text: "Engineer who ships full-stack products.", refs: [] } } as unknown as TailoredProfile;
  // The repair alone, so the assertion is about what it keeps.
  const { profile, changes } = enforceContentRules(reply, bare, JD);
  // No summary: untraceable prose is never printed, even when nothing can replace it.
  assert.equal(profile.summary, null);
  // And no "added summary" change with an undefined ref was recorded.
  assert.equal(changes.some((c) => c.section === "summary"), false);
});

test("tailor picks the cited summary variant instead of failing (LSEG 2b7db9a2)", async () => {
  // The reply cites the AI variant's paragraph verbatim without picking it.
  const reply = { ...greedyAnswer(), section_order: ["summary", ...greedyAnswer().section_order], summary: { text: "Engineer building LLM features with TypeScript.", refs: ["summary-ai"] } } as unknown as TailoredProfile;
  // Tailored.
  const outcome = await tailorerReplying(reply)(POSTING);
  // Stored, not refused.
  assert.equal(outcome.kind, "tailored", JSON.stringify(outcome));
  // The picked variant is in the stored refs, so the rebuild re-validates to the same resume; its summary prints.
  if (outcome.kind === "tailored") assert.deepEqual([outcome.refs.summary_variant, outcome.resume.summary], ["variant-ai", "Engineer building LLM features with TypeScript."]);
});

test("header role title is the role applied for, cleaned of seniority, never invented", () => {
  // Seniority and level words go; the qualifier after the separator goes.
  assert.equal(cleanRoleTitle("Senior Software Engineer II - Payments (Remote)"), "Software Engineer");
  // "Intern" is the role, so it stays.
  assert.equal(cleanRoleTitle("Software Engineer Intern, Bangalore"), "Software Engineer Intern");
  // Hyphenated words and tech symbols survive.
  assert.equal(cleanRoleTitle("Sr. Full-Stack Engineer | Node.js"), "Full-Stack Engineer");
  // Nothing usable: null, so the old headline stands.
  assert.equal(cleanRoleTitle("Lead"), null);
  // Only the approved seniority words go: "Junior" is a level he holds, so it stays.
  assert.equal(cleanRoleTitle("Junior Data Scientist"), "Junior Data Scientist");
  // Markup can never reach the header: no role noun in it, so nothing prints (it was "script x /script" before 2026-11-09).
  assert.equal(cleanRoleTitle("<script>x</script>"), null);
});

test("header role title is singular, a whole role phrase, never a fragment (2026-11-09 QA rows)", () => {
  // d0a7d313: a plural posting title still names ONE role for this candidate.
  assert.equal(cleanRoleTitle("Backend Interns"), "Backend Intern");
  // d45c3ba6: the role is the noun phrase; the "with <stack>" tail is a qualifier, not part of the role.
  assert.equal(cleanRoleTitle("Java Developer with Angular , Spring Hibernate"), "Java Developer");
  // 4bd46605: the first segment names a team, not a role; the segment that holds the role noun wins.
  assert.equal(cleanRoleTitle("Models Infrastructure Platform Enablement (Python + React), Multi-Asset  Strategies & Solutions (MASS), Analyst"), "Analyst");
  // Same failure, live: a team or org prefix before " - " used to become the whole headline.
  assert.equal(cleanRoleTitle("GTSM - Site Reliability Engineer"), "Site Reliability Engineer");
  // A year before the role is not the role either.
  assert.equal(cleanRoleTitle("2027 - Software Engineering Intern, AMER"), "Software Engineering Intern");
  // No role noun anywhere: null, so the variant's or the master's headline prints as before.
  assert.equal(cleanRoleTitle("Python full stack + AWS (ETL)"), null);
});

test("header keeps a trailing Intern segment, without its season or year (Teja, 2026-11-09 17:02 IST)", () => {
  // The intern word sat after a comma, so the role alone printed "Software Engineer" for an internship.
  assert.equal(cleanRoleTitle("Software Engineer, Intern"), "Software Engineer Intern");
  // A season beside the intern word is not part of the role; the team code in brackets is dropped as before.
  assert.equal(cleanRoleTitle("Software Engineer (CPD) - Winter Intern"), "Software Engineer Intern");
  // Year, season and "Co-op" go; "Internship" stays as is (the closed list does not map it to "Intern").
  assert.equal(cleanRoleTitle("Summer 2027 Software Engineering Internship/Co-op"), "Software Engineering Internship");
  // Already an intern title: nothing appended twice.
  assert.equal(cleanRoleTitle("Backend Intern"), "Backend Intern");
  // No intern word anywhere: nothing appended, ever.
  assert.equal(cleanRoleTitle("Software Engineer"), "Software Engineer");
  // A later segment that holds MORE than an intern word is a qualifier, not the intern marker.
  assert.equal(cleanRoleTitle("Software Engineer - Intern Platform Team"), "Software Engineer");
});

test("header singularising touches only the closed list of role nouns", () => {
  // Words that END in s but are not plurals survive untouched beside a role noun.
  assert.equal(cleanRoleTitle("Sales Engineer"), "Sales Engineer");
  // "Analytics" is a field, not "Analytic"s.
  assert.equal(cleanRoleTitle("Analytics Engineer"), "Analytics Engineer");
  // Only the role noun is singularised; "Business" keeps its s.
  assert.equal(cleanRoleTitle("Business Analysts"), "Business Analyst");
  // "DevOps" keeps its s; the plural role noun after it does not.
  assert.equal(cleanRoleTitle("DevOps Engineers"), "DevOps Engineer");
  // "Kubernetes" keeps its s.
  assert.equal(cleanRoleTitle("Kubernetes Developer"), "Kubernetes Developer");
});

test("tailor header names the role applied for (rule 5)", async () => {
  // A senior-titled posting for an early-career candidate.
  const outcome = await tailorerReplying(greedyAnswer())({ ...POSTING, jobTitle: "Senior Backend Engineer II (Payments)" });
  // Stored.
  assert.equal(outcome.kind, "tailored", JSON.stringify(outcome));
  // The header prints the role without the seniority, and the refs carry it for the rebuild.
  if (outcome.kind === "tailored") assert.deepEqual([outcome.resume.identity.headline, outcome.refs.headline_title], ["Backend Engineer", "Backend Engineer"]);
});

test("every tailored resume prints a summary: a missing one is the most JD-matched variant's own paragraph", () => {
  // The model wrote no summary and picked no variant.
  const { profile } = enforceContentRules(greedyAnswer(), master(), JD);
  // The AI variant names TypeScript (a JD keyword); the web one does not: its paragraph, verbatim, cited and picked.
  assert.deepEqual([profile.summary, profile.summary_variant], [{ text: "Engineer building LLM features with TypeScript.", refs: ["summary-ai"] }, "variant-ai"]);
  // And it prints: first in the section order.
  assert.equal(profile.section_order[0], "summary");
});

test("every tailored resume prints a summary (through the real tailorer)", async () => {
  // The model's reply has summary: null.
  const outcome = await tailorerReplying(greedyAnswer())(POSTING);
  // Stored.
  assert.equal(outcome.kind, "tailored", JSON.stringify(outcome));
  // The paragraph prints, and the gate names nothing missing.
  if (outcome.kind === "tailored") assert.deepEqual([outcome.resume.summary, checkContentRules(outcome.resume, master()).includes("summary: missing")], ["Engineer building LLM features with TypeScript.", false]);
});

test("checkContentRules names a missing summary", () => {
  // The greedy answer resolved as is: no summary.
  const verdict = validateTailoredProfile(greedyAnswer(), master(), VERSION);
  // Resolves.
  assert.equal(verdict.ok, true);
  // Named.
  if (verdict.ok) assert.ok(checkContentRules(verdict.resume, master()).includes("summary: missing"));
});

test("the validator refuses a header title outside the cleaned shape", () => {
  // A sentence with markup, injected into the refs.
  const bad = { ...enforceContentRules(greedyAnswer(), master(), JD).profile, headline_title: "<b>Hire me</b>" } as unknown as TailoredProfile;
  // Refused, never printed.
  assert.equal(validateTailoredProfile(bad, master(), VERSION).ok, false);
});

// --- AI skills floor (Teja, 2026-11-10): every tailored resume carries an AI skills group of >= min(5, master) skills. ---

/** n master skills in category "AI", ids ai-1..ai-n, so a test can hold exactly the count it names. */
const aiSkills = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `ai-${i + 1}`, name: `AI Skill ${i + 1}`, category: "AI" }));

/** The base master plus n AI skills: everything else unchanged, so the only floor that can move is the new one. */
const masterWithAi = (n: number) => ({ ...master(), skills: [...master().skills, ...aiSkills(n)] }) as MasterProfile;

/** checkContentRules on a COMPLIANT resolved resume printing the first `printed` AI skills, against a master holding `held`. */
function aiGate(printed: number, held: number): string[] {
  // The enforced greedy answer: the fixture the "gate then passes" test proves yields [] against master().
  const { profile } = enforceContentRules(greedyAnswer(), master(), JD);
  // Resolved through the real validator, so the resume has the exact shape the gate runs on in production.
  const verdict = validateTailoredProfile(profile, master(), VERSION);
  // A refusal would be a fixture bug, not the rule under test.
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  // Narrowing for the type checker; unreachable after the assert above.
  if (!verdict.ok) return ["<unresolved>"];
  // The resolved AI entries ({ref, name, category}), taken from the same master the gate is given.
  const printedAi = aiSkills(held).slice(0, printed).map((s) => ({ ref: s.id, name: s.name, category: s.category }));
  // The compliant resume with its AI skills appended: only the skills list differs from the passing case.
  const resume = { ...verdict.resume, skills: [...verdict.resume.skills, ...printedAi] };
  // Gated against the master holding `held` AI skills, so F = min(5, held).
  return checkContentRules(resume, masterWithAi(held));
}

test("AI skills floor (2026-11-10): 4 AI skills against an 18-skill AI master is refused, naming the floor of 5", () => {
  // Exactly one break: every other rule is met by the compliant fixture, so the array is the whole verdict.
  assert.deepEqual(aiGate(4, 18), ["skills[AI]: 4, needs 5"]);
});

test("AI skills floor (2026-11-10): 5 AI skills meets the floor", () => {
  // At the floor: compliant, nothing broken at all.
  assert.deepEqual(aiGate(5, 18), []);
});

test("AI skills floor (2026-11-10): a master with only 3 AI skills is never padded, so those 3 comply", () => {
  // F = min(5, 3) = 3: the resume holds everything the master can supply.
  assert.deepEqual(aiGate(3, 3), []);
});

test("AI skills floor (2026-11-10): a master with no AI category requires none", () => {
  // F = min(5, 0) = 0: no AI group to print, so no break.
  assert.deepEqual(aiGate(0, 0), []);
});

test("AI skills floor (2026-11-10): 0 AI skills against an 18-skill AI master is refused", () => {
  // A missing group counts as 0, never as "no rule".
  assert.deepEqual(aiGate(0, 18), ["skills[AI]: 0, needs 5"]);
});

test("AI skills floor (2026-11-10): the string keeps the web's rule-key contract (pageFitEdit.ts ruleKey)", () => {
  // The break for a short AI group.
  const aiBreak = aiGate(4, 18).find((s) => s.startsWith("skills[AI]"));
  // It exists at all, or the two checks below would pass vacuously on undefined.
  assert.ok(aiBreak !== undefined, "no skills[AI] break was emitted");
  // The web keys a rule by the text before the FIRST ":", so the prefix must be exactly the rule identity.
  assert.equal(aiBreak.split(":")[0], "skills[AI]");
  // The web reads "at most" as a max rule; this is a floor, so the phrase must be absent.
  assert.equal(aiBreak.includes("at most"), false);
});
