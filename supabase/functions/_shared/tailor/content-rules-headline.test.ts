// The resume headline rule (Teja, 2026-11-18 21:47: "AI writes the whole-resume title"; findings doc section 7):
// a job title, never a team name, never bare "Intern", never more senior than the job's. The model may now write it,
// so code checks it against the job title it came from. These tests pin the rule, and pin that every headline the
// existing code path (cleanRoleTitle) produces still passes, so old rows and today's tailor are not refused.
import { test } from "node:test";
// Strict comparisons.
import assert from "node:assert/strict";
// The rule under test, its fallback list, and the old producer it must agree with.
import { checkHeadline, cleanRoleTitle, HEADLINE_FALLBACKS } from "./content-rules.ts";

test("a headline cut from the job title passes", () => {
  // Tail dropped (keep7 app1 shape).
  assert.equal(checkHeadline("Full-Stack Engineer", "Full-Stack Engineer - ElevenMusic"), null);
  // A team segment first, the role later (keep7 app2 shape).
  assert.equal(checkHeadline("Software Engineer", "Supabase - Software Engineer - Auth"), null);
  // A plural role noun in the posting, singular on the resume.
  assert.equal(checkHeadline("Backend Engineer", "Backend Engineers"), null);
  // An internship keeps "Intern".
  assert.equal(checkHeadline("Software Engineer Intern", "Software Engineer, Intern"), null);
});

test("the four fallback titles pass for any job, and are exactly the spec's list", () => {
  // The spec's fallbacks (keep7 SPEC.md, the Aczen titles without "Intern").
  assert.deepEqual([...HEADLINE_FALLBACKS], ["Full Stack AI Engineer", "Software Engineer", "Backend Engineer", "AI Engineer"]);
  // A posting whose own words make no clean title (keep7 app10 shape).
  assert.equal(checkHeadline("Software Engineer", "Analyst I Software Engineering"), null);
});

test("a team name, a bare Intern, a senior title or a word the posting never used is refused, each with a reason", () => {
  // No role noun: a team name (findings doc section 3).
  assert.match(checkHeadline("Models Infrastructure Platform Enablement", "Models Infrastructure Platform Enablement") ?? "", /role/);
  // Bare intern.
  assert.match(checkHeadline("Intern", "Summer Intern 2026") ?? "", /intern/i);
  // Seniority, even when the posting has it: the candidate holds none (stricter than "never above the JD's", on purpose).
  assert.match(checkHeadline("Senior Software Engineer", "Senior Software Engineer") ?? "", /senior/i);
  // A discipline the posting never named.
  assert.match(checkHeadline("Data Scientist", "Backend Engineer - Payments") ?? "", /Data|Scientist/);
  // Markup, never printed.
  assert.notEqual(checkHeadline("<b>Engineer</b>", "Engineer"), null);
});

test("with no job title only a fallback passes (nothing to trace is not a pass)", () => {
  // A fallback.
  assert.equal(checkHeadline("Software Engineer", null), null);
  // Anything else cannot be traced.
  assert.notEqual(checkHeadline("Java Developer", null), null);
});

test("every headline cleanRoleTitle produces passes checkHeadline for the same title (old rows stay valid)", () => {
  // Titles from cleanRoleTitle's own tests and live shapes.
  const titles = [
    "Senior Software Engineer II", "GTSM - Site Reliability Engineer", "Software Engineer, Intern", "Backend Engineers (Remote)",
    "Data Scientist I", "Gen AI Engineer-AWS", "Java Developer with Angular , Spring Hibernate", "Summer 2026 Software Engineering Internship",
    "Full-Stack Engineer (Frontend Leaning) - Studio", "Machine Learning Engineer | Search",
  ];
  // Each title the old producer can clean.
  for (const title of titles) {
    // The old producer's headline.
    const cleaned = cleanRoleTitle(title);
    // Null means the old path printed the master's own headline, which the auditor accepts separately.
    if (cleaned === null) continue;
    // Must pass the new rule.
    assert.equal(checkHeadline(cleaned, title), null, `${title} -> ${cleaned}`);
  }
});
