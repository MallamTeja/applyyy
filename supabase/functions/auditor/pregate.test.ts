// Leak 1 (2026-11-05): no agent re-judged a row once it passed the matcher, so a row that
// passed under an older gate reached Teja's approval queue after the gate learned to drop it.
// Cohere 4d0680ee ("Middle East") passed before the work-auth gate had a region table and was
// APPROVED on 11-05. The auditor is the last agent before a human, so it re-runs the matcher's
// pre-gate (firstPreGateDrop) over every `tailored` row it audits. These tests pin that seam
// with the real rows' shapes and Teja's live config (SELECTed 2026-11-05 13:2x IST).
import { describe, test } from "node:test";
// Strict deep equality, so a changed verdict shape fails here.
import assert from "node:assert/strict";
// The verdict the auditor calls (its config loader is tested in _shared/pregate-config-loader.test.ts).
import { auditorContentRulesDrop, auditorPreGateDrop, type AuditorJobEmbed } from "./pregate.ts";
// The two shapes the content-rules fixtures are cast to.
import type { MasterProfile, ResolvedResume } from "../_shared/contracts/shared-types.ts";
// The preference shape, so the fixture is checked against the real type.
import type { PreGatePreferences } from "../matcher/tech-pregate.ts";

// Teja's live search_preferences (a subset of the 55 titles; the gates read the lists as given)
// and the enabled experience_ceiling (max_years 1).
const TEJA_LIVE: PreGatePreferences = {
  // Titles from the live row, including the two these jobs hit.
  titles: ["Software Engineer", "Forward Deployed", "Intern", "Developer"],
  // Live keywords.
  keywords: ["Node.js", "React", "TypeScript", "Python", "REST APIs"],
  // Live exclusions, the ones relevant to these titles.
  excludedKeywords: ["Senior", "Lead", "Staff", "Manager"],
  // Live work-auth list.
  workAuthorizedCountries: ["India", "Nepal", "Bhutan"],
  // Live remote policy.
  remoteLocationPolicy: "unlocked_or_authorized",
  // Live ceiling.
  experienceMaxYears: 1,
};

// Cohere 4d0680ee as stored: the JD names the region the role is open to.
const COHERE: AuditorJobEmbed = {
  // Live title.
  title: "Forward Deployed Engineer, Agentic Platform",
  // The sentence the trace quoted, inside JD-like text.
  description_raw: "Own customer deployments.\n\nWe are open to candidates currently based in the Middle East or who are open to travelling or relocating.",
  // Live location.
  location_raw: "Middle East",
  // Null on every live row.
  min_experience_years: null,
  // Found by the Ashby scout, not pasted.
  discovered_via: ["ashby"],
};

describe("auditorPreGateDrop", () => {
  test("Cohere (Middle East) is dropped for work authorisation", () => {
    // The live row's shape.
    const drop = auditorPreGateDrop(COHERE, TEJA_LIVE);
    // A drop, with the work-auth gate's code.
    assert.equal(drop?.code.startsWith("work_auth"), true, JSON.stringify(drop));
  });

  test("Scale AI's San Francisco internship is dropped for work authorisation", () => {
    // Scale 461f9f6b as stored.
    const drop = auditorPreGateDrop({ title: "Software Engineering Intern (Summer 2027)", description_raw: "Build data infrastructure.", location_raw: "San Francisco, CA", min_experience_years: null, discovered_via: ["greenhouse"] }, TEJA_LIVE);
    // Same gate, same family of code.
    assert.equal(drop?.code.startsWith("work_auth"), true, JSON.stringify(drop));
  });

  test("Chime's 'Remote, USA' is dropped: the remote is locked to a country Teja is not authorised in", () => {
    // Chime 0ebae14d as stored.
    const drop = auditorPreGateDrop({ title: "Software Engineer, AI Enablement", description_raw: "Internal AI platforms.", location_raw: "Remote, USA", min_experience_years: null, discovered_via: ["greenhouse"] }, TEJA_LIVE);
    // Dropped by the work-auth gate.
    assert.equal(drop?.code.startsWith("work_auth"), true, JSON.stringify(drop));
  });

  test("a role in India passes the gate", () => {
    // The kind of row the queue should keep.
    const drop = auditorPreGateDrop({ title: "Software Engineer", description_raw: "Join our Bengaluru team.", location_raw: "Bengaluru, India", min_experience_years: null, discovered_via: ["greenhouse"] }, TEJA_LIVE);
    // No objection.
    assert.equal(drop, null);
  });

  test("a human-picked (pasted) job is never re-gated, even the Cohere shape", () => {
    // Teja chose it by hand; the gates are for agent-found rows (isHumanPicked).
    const drop = auditorPreGateDrop({ ...COHERE, discovered_via: ["ashby", "manual"] }, TEJA_LIVE);
    // Kept.
    assert.equal(drop, null);
  });

  test("a missing job embed is refused, never read as 'no objection'", () => {
    // Fail closed (CLAUDE.md §6): no job means the gate cannot judge, not that it passed.
    assert.throws(() => auditorPreGateDrop(null, TEJA_LIVE), /no job embed/);
  });
});


// Content rules (Teja, 2026-11-08): live rows reached the approval queue with 3 projects. The auditor now
// runs the tailor's checkContentRules against the PINNED master before any human sees the row.
// Only the five sections the gate counts are built; the cast is the narrowest way to a typed fixture.
type Entry = { ref: string; bullets: { ref: string; text: string }[] };
// A master node with n bullets, in the master's id/text shape.
const masterNode = (id: string, n: number) => ({ id, bullets: Array.from({ length: n }, (_, i) => ({ id: `${id}_b${i}`, text: `${id} bullet ${i}` })) });
// A resolved entry printing n bullets of that node.
const resumeEntry = (ref: string, n: number): Entry => ({ ref, bullets: Array.from({ length: n }, (_, i) => ({ ref: `${ref}_b${i}`, text: `${ref} bullet ${i}` })) });

// A master with 3 projects of 4 bullets, the Aczen entry, 3 certifications, 2 achievements, 2 educations.
const MASTER = {
  // Three projects: the case where the cap of 2 binds.
  projects: [masterNode("proj_a", 4), masterNode("proj_b", 4), masterNode("proj_c", 4)],
  // The floor-named experience.
  experience: [masterNode("exp_aczen", 4)],
  // 3 certifications: below the floor of 5 (2026-11-09), so min(5, 3) = 3 binds; a short master still passes.
  certifications: [masterNode("cert_a", 0), masterNode("cert_b", 0), masterNode("cert_c", 0)],
  // 2 achievements: ALL of them are required since 2026-11-09, which here is both.
  achievements: [masterNode("ach_a", 1), masterNode("ach_b", 1)],
  // Both educations.
  education: [masterNode("edu_a", 0), masterNode("edu_b", 0)],
  // A summary to print, so "every tailored resume prints a summary" (2026-11-08 16:06 IST) binds here too.
  summary: { id: "summary_master", text: "Engineer." },
  // No skills: the AI skills floor (2026-11-10, T13) is min(5, 0) = 0 here, so it cannot break this fixture's verdicts.
  skills: [],
} as unknown as MasterProfile;

// A resume meeting every rule against MASTER.
const COMPLIANT = {
  // Exactly 2 projects, 4 bullets each.
  projects: [resumeEntry("proj_a", 4), resumeEntry("proj_b", 4)],
  // Aczen at its floor.
  experience: [resumeEntry("exp_aczen", 4)],
  // 3 certifications.
  certifications: [resumeEntry("cert_a", 0), resumeEntry("cert_b", 0), resumeEntry("cert_c", 0)],
  // 2 achievements.
  achievements: [resumeEntry("ach_a", 1), resumeEntry("ach_b", 1)],
  // 2 educations.
  education: [resumeEntry("edu_a", 0), resumeEntry("edu_b", 0)],
  // The summary prints: text, and its section in the order.
  summary: "Engineer.",
  // Every section the resume prints, summary first.
  section_order: ["summary", "experience", "projects", "education", "achievements", "certifications"],
  // A real resolved resume always carries a skills array; the AI floor (2026-11-10) reads it.
  skills: [],
} as unknown as ResolvedResume;

describe("auditorContentRulesDrop", () => {
  test("auditor never passes a resume with 3 projects to a human", () => {
    // The live leak: every project the master holds, one over the cap.
    const resume = { ...COMPLIANT, projects: [resumeEntry("proj_a", 4), resumeEntry("proj_b", 4), resumeEntry("proj_c", 4)] } as unknown as ResolvedResume;
    // The verdict index.ts acts on.
    const drop = auditorContentRulesDrop(resume, MASTER);
    // A drop, with the content-rules code, naming the projects rule.
    assert.equal(drop?.code, "content_rules", JSON.stringify(drop));
    // The detail the human reads names the broken rule.
    assert.match(drop!.reason, /projects: 3, at most 2/);
  });

  test("a compliant resume is not dropped by the content rules", () => {
    // Every floor met, the cap respected.
    assert.equal(auditorContentRulesDrop(COMPLIANT, MASTER), null);
  });

  test("2026-11-09 ruling: a resume missing one master achievement, or under 5 certifications, is dropped by name", () => {
    // A bigger master: 6 certifications and 3 achievements, so both new floors bind (5, and all 3).
    const big = { ...MASTER, certifications: ["a", "b", "c", "d", "e", "f"].map((x) => masterNode(`cert_${x}`, 0)), achievements: [masterNode("ach_a", 1), masterNode("ach_b", 1), masterNode("ach_c", 1)] } as unknown as MasterProfile;
    // The old floors' resume: 4 certifications and 2 of the 3 achievements.
    const old = { ...COMPLIANT, certifications: ["a", "b", "c", "d"].map((x) => resumeEntry(`cert_${x}`, 0)) } as unknown as ResolvedResume;
    // The verdict index.ts acts on.
    const drop = auditorContentRulesDrop(old, big);
    // Dropped under the content-rules code.
    assert.equal(drop?.code, "content_rules", JSON.stringify(drop));
    // Both new floors named, so the human sees which rule held.
    assert.match(drop!.reason, /certifications: 4, needs 5/);
    // Every achievement the master holds.
    assert.match(drop!.reason, /achievements: 2, needs 3/);
  });

  test("a missing resume or master is refused, never read as compliant", () => {
    // Fail closed (CLAUDE.md section 6): no resume to judge.
    assert.throws(() => auditorContentRulesDrop(null, MASTER), /no resolved resume/);
    // No master: every floor would read 0.
    assert.throws(() => auditorContentRulesDrop(COMPLIANT, null), /no pinned master/);
    // A section missing from the stored resume is damaged data, not "zero, fine".
    assert.throws(() => auditorContentRulesDrop({ ...COMPLIANT, certifications: undefined } as unknown as ResolvedResume, MASTER), /resume.certifications is not an array/);
    // A master missing its skills (2026-11-10, T13): named, never a bare TypeError from the AI skills floor.
    assert.throws(() => auditorContentRulesDrop(COMPLIANT, { ...MASTER, skills: undefined } as unknown as MasterProfile), /master.skills is not an array/);
  });
});
