// The auditor's master-facts gate (tailor #5 parcel 1, P0 2026-11-21): before a row reaches Teja, every printed
// employer, role, date, school, project and award line must be the pinned master's own (or an allow-listed Aczen
// title), and the headline must pass the headline rule. FamPay shipped "Data Analyst Intern" with the auditor silent.
import { test } from "node:test";
// Strict comparisons.
import assert from "node:assert/strict";
// Read the index source for the wiring test.
import { readFileSync } from "node:fs";
// The unit under test.
import { auditorMasterFactsDrop } from "./master-facts.ts";
// Contract types.
import type { MasterProfile, ResolvedResume } from "../_shared/contracts/shared-types.ts";

// A master with one allow-listed employer, one education, one project, one award and one certification.
function master(): MasterProfile {
  // Fresh per test.
  return {
    schema_version: 1,
    identity: { full_name: "Teja Mallam", headline: "Software Engineer", email: "t@example.com", phone: null, location: "Hyderabad", links: [] },
    summary: null,
    // One owner-written variant headline, which the auditor accepts as the owner's own words.
    summary_variants: [{ id: "v1", label: "AI", headline: "AI Product Engineer", summary: { id: "sv1", text: "x" } }],
    education: [{ id: "edu", institution: "MLRIT", degree: "B.Tech", field: "CSE", start_display: "2022", end_display: "2026", start_date: null, end_date: null, grade_display: "8.4", bullets: [] }],
    experience: [{ id: "exp_aczen", company: "Aczen Technologies", role: "Full Stack AI Engineer Intern", location: "Hyderabad", start_display: "Jun 2026", end_display: "Present", start_date: null, end_date: null, bullets: [] }],
    projects: [{ id: "proj", name: "applyyy", links: [], start_display: "2026", end_display: "2026", start_date: null, end_date: null, bullets: [] }],
    skills: [],
    achievements: [{ id: "ach", label: "Winner", description: "SIH", bullets: [] }],
    certifications: [{ id: "cert", label: "AWS CCP", description: null, bullets: [] }],
    links: [],
  };
}

// The resume the validator would have resolved from that master, untouched.
function resume(): ResolvedResume {
  // Every display field copied as the validator copies it.
  return {
    schema_version: 1,
    master_version: 47,
    identity: { full_name: "Teja Mallam", headline: "Backend Engineer", email: "t@example.com", phone: null, location: "Hyderabad", links: [] },
    section_order: ["experience", "projects", "education", "achievements", "certifications"],
    summary: null,
    skills: [],
    experience: [{ ref: "exp_aczen", company: "Aczen Technologies", role: "Full Stack AI Engineer Intern", location: "Hyderabad", start_display: "Jun 2026", end_display: "Present", bullets: [] }],
    projects: [{ ref: "proj", name: "applyyy", links: [], start_display: "2026", end_display: "2026", bullets: [] }],
    education: [{ ref: "edu", institution: "MLRIT", degree: "B.Tech", field: "CSE", start_display: "2022", end_display: "2026", grade_display: "8.4", bullets: [] }],
    achievements: [{ ref: "ach", label: "Winner", description: "SIH", bullets: [] }],
    certifications: [{ ref: "cert", label: "AWS CCP", description: null, bullets: [] }],
  };
}

// The job the row was tailored for.
const JOB = "Backend Engineer - Payments";

test("a resume whose facts are the master's own, with an allow-listed Aczen title and a traced headline, passes", () => {
  // Untouched.
  assert.equal(auditorMasterFactsDrop(resume(), master(), JOB), null);
  // An allow-listed title in place of the master role.
  const titled = resume();
  // Mutable copy for the test (the contract types are readonly).
  (titled.experience as { role: string }[])[0]!.role = "Backend Engineer Intern";
  // Still passes.
  assert.equal(auditorMasterFactsDrop(titled, master(), JOB), null);
});

test("a retitled role, a renamed company or a moved date is dropped as master_facts, each named", () => {
  // The FamPay case: a title neither in the master nor on the allow-list.
  const r = resume();
  // Retitled.
  (r.experience as { role: string; company: string; start_display: string }[])[0]!.role = "Data Analyst Intern";
  // Renamed employer.
  (r.experience as { role: string; company: string; start_display: string }[])[0]!.company = "Aczen Fintech";
  // Moved start.
  (r.experience as { role: string; company: string; start_display: string }[])[0]!.start_display = "Jan 2025";
  // The verdict.
  const drop = auditorMasterFactsDrop(r, master(), JOB);
  // One drop, with every broken fact named.
  assert.equal(drop?.code, "master_facts");
  // Each named.
  for (const part of ["role", "Data Analyst Intern", "company", "start_display"]) assert.ok(drop!.reason.includes(part), `${part} in ${drop!.reason}`);
});

test("education, project, award and certification display fields are checked too; an unknown entry is named", () => {
  // Inflated award label and a degree upgrade.
  const r = resume();
  // Award.
  (r.achievements as { label: string }[])[0]!.label = "International Winner";
  // Degree.
  (r.education as { degree: string }[])[0]!.degree = "M.Tech";
  // An entry the master does not hold.
  (r.projects as { ref: string }[])[0]!.ref = "proj_ghost";
  // The verdict names all three.
  const reason = auditorMasterFactsDrop(r, master(), JOB)?.reason ?? "";
  // Each.
  for (const part of ["International Winner", "M.Tech", "proj_ghost"]) assert.ok(reason.includes(part), reason);
});

test("the headline: the master's or a variant's own headline passes; a team name or untraced title is dropped", () => {
  // The master's own headline (old rows where cleanRoleTitle found no role).
  const own = resume();
  // Master headline.
  (own.identity as { headline: string | null }).headline = "Software Engineer";
  // Passes.
  assert.equal(auditorMasterFactsDrop(own, master(), JOB), null);
  // A variant's headline, the owner's words.
  (own.identity as { headline: string | null }).headline = "AI Product Engineer";
  // Passes.
  assert.equal(auditorMasterFactsDrop(own, master(), JOB), null);
  // A headline the job never offered.
  (own.identity as { headline: string | null }).headline = "Data Scientist";
  // Dropped with the headline rule's reason.
  assert.match(auditorMasterFactsDrop(own, master(), JOB)?.reason ?? "", /headline/);
});

test("a missing resume or master throws (a per-row failure), never a pass", () => {
  // No resume.
  assert.throws(() => auditorMasterFactsDrop(null, master(), JOB));
  // No master.
  assert.throws(() => auditorMasterFactsDrop(resume(), null, JOB));
});

test("index.ts runs the master-facts gate after content rules, before the audit, and moves a hit to failed", () => {
  // The auditor's source.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  // The call, fed the pinned master and the job title.
  const call = source.indexOf("auditorMasterFactsDrop(resume, pinned.master,");
  // Present.
  assert.ok(call > 0, "auditorMasterFactsDrop call missing");
  // After the content-rules gate and before the audit.
  assert.ok(call > source.indexOf("auditorContentRulesDrop(resume, pinned.master)") && call < source.indexOf("auditApplication(pinned.master"), "order");
  // The block from the call to its stage name: the guard, the failed move and the skip must all be in it.
  const block = source.slice(call, source.indexOf('stage: "auditor_master_facts"') + 40);
  // Its move carries its own stage name (the slice ends past it, so a missing stage leaves a short block).
  assert.ok(source.includes('stage: "auditor_master_facts"'), "stage name");
  // A hit is acted on: the verdict guards the move (a dead `if (false)` here would print the misstated row to Teja).
  assert.ok(block.includes("if (factsDrop !== null) {"), "the verdict must guard the move");
  // The move is off the queue, to failed.
  assert.ok(/p_to_status: "failed"/.test(block), "moves to failed");
});
