// fitToOnePage: the content side of the one-page rule (Teja, 2026-11-07).
// The page measurement itself is proven against real Chromium in
// worker/test/page-fit-calibration.test.ts; here `fits` is a stand-in (a content budget), so
// every assertion is about WHAT is removed, in WHICH order, and WHERE it stops.
// Since Teja's 2026-11-09 20:41 IST ruling, certification and achievement ENTRIES are never removed: only bullets go.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ResolvedResume } from "../contracts/shared-types.ts";
import { fitToOnePage, PAGE_FIT_FLOORS, TRIM_ORDER, withoutTrimmed } from "./page-trim.ts";

/** A resolved bullet whose text carries the given words (keywords make it strong). */
const b = (ref: string, text = "did routine things") => ({ ref, text, master_text: text });

/** A resume under the content rules, shaped like master v28 + Teja's 2 new certifications: Aczen 5 bullets, Student
 * Tribe 2, the 2 projects with >= 4 bullets (6/4), 3 achievements, and 5 certifications (the 2026-11-09 floor). */
function v24Like(): ResolvedResume {
  // Every section the trimmer reads; skills and education are present to prove they are untouched.
  return {
    schema_version: 1,
    master_version: 24,
    section_order: ["summary", "skills", "experience", "projects", "education", "achievements", "certifications"],
    summary: "Engineer.",
    skills: [{ ref: "sk_ts", name: "TypeScript", category: "lang" }, { ref: "sk_go", name: "Go", category: "lang" }, { ref: "sk_sql", name: "SQL", category: "db" }],
    experience: [
      { ref: "exp_aczen", bullets: [b("a1", "typescript postgres"), b("a2"), b("a3", "typescript"), b("a4"), b("a5", "postgres")] },
      { ref: "exp_student_tribe", bullets: [b("st1"), b("st2", "typescript")] },
    ],
    projects: [
      { ref: "proj_one_on_one", bullets: [b("p1", "typescript"), b("p2"), b("p3", "postgres"), b("p4"), b("p5", "typescript postgres"), b("p6")] },
      { ref: "proj_applyy", bullets: [b("y1", "typescript"), b("y2"), b("y3"), b("y4")] },
    ],
    education: [{ ref: "edu_mlrit", bullets: [] }, { ref: "edu_tkr", bullets: [] }],
    achievements: [{ ref: "ach_a", bullets: [b("aa1")] }, { ref: "ach_b", bullets: [b("ab1")] }, { ref: "ach_c", bullets: [b("ac1")] }],
    certifications: [
      { ref: "cert_sql", label: "SQL postgres", description: null, bullets: [] },
      { ref: "cert_prompt", label: "Prompt Engineering", description: null, bullets: [] },
      { ref: "cert_ml", label: "Machine Learning", description: null, bullets: [] },
      { ref: "cert_cloud", label: "Cloud Practitioner", description: null, bullets: [] },
      // The 5th: exactly the floor, so the old certification step would have had nothing either way above 5.
      { ref: "cert_aws", label: "AWS Associate", description: null, bullets: [] },
    ],
  } as unknown as ResolvedResume;
}

/** Content units: every bullet plus every certification entry. */
function units(r: ResolvedResume): number {
  // Bullets across every section that has them.
  const bullets = [...r.experience, ...r.projects, ...r.achievements].reduce((n, e) => n + e.bullets.length, 0);
  // Plus certifications.
  return bullets + r.certifications.length;
}

// The posting's keywords for every test.
const JD = ["typescript", "postgres"];
// Start: 5+2 + 6+4 + 3 bullets + 5 certs = 25 units.
const START = 25;
// Bullets left when every entry sits at its floor: Aczen 4, Student Tribe 1, projects 4+4, achievements 3.
const FLOOR_BULLETS = 4 + 1 + 4 + 4 + 3;
// Certification entries, all of which always stay.
const CERTS = 5;

test("a resume that already fits is returned untouched", () => {
  // The input, kept to compare identity.
  const resume = v24Like();
  // Generous budget.
  const out = fitToOnePage(resume, JD, () => true);
  // Fits, nothing removed, the same object.
  assert.deepEqual([out.fits, out.trimmed, out.resume === resume], [true, [], true]);
});

test("TRIM_ORDER (ruling 2026-11-09 20:41): only bullets: projects over the cap, then the weakest bullets", () => {
  // The order is data; this pins it so putting certifications or achievements back is a deliberate, visible change.
  assert.deepEqual(TRIM_ORDER, ["project_bullet_over_cap", "weakest_bullet"]);
});

test("certification floor is 5 and achievements are all of them", () => {
  // Teja's numbers, pinned where the floors live.
  assert.equal(PAGE_FIT_FLOORS.minCertifications, 5);
  // "All" = no ceiling: content-rules takes min(this, master count), so every master achievement is required.
  assert.equal(PAGE_FIT_FLOORS.minAchievements, Number.POSITIVE_INFINITY);
});

test("one line over with 5 certifications and a 5-bullet project cuts a project bullet, never a certification", () => {
  // A project at 5 bullets (above the cap of 4) beside the 5 certifications.
  const resume = { ...v24Like(), projects: [{ ref: "proj_x", bullets: [b("x1"), b("x2"), b("x3"), b("x4"), b("x5")] }] } as unknown as ResolvedResume;
  // Over by exactly one unit.
  const out = fitToOnePage(resume, JD, (r) => units(r) <= units(resume) - 1);
  // The project's latest zero-score bullet went.
  assert.deepEqual(out.trimmed, [{ step: "project_bullet_over_cap", ref: "x5", text: "did routine things" }]);
  // All 5 certifications stayed.
  assert.equal(out.resume.certifications.length, CERTS);
});

test("an overfull page down to every bullet floor keeps all 5 certifications and all 3 achievements", () => {
  // Down to the bullet floors with every certification.
  const out = fitToOnePage(v24Like(), JD, (r) => units(r) <= FLOOR_BULLETS + CERTS);
  // Fits.
  assert.equal(out.fits, true);
  // Only bullets went.
  assert.ok(out.trimmed.every((t) => t.step === "project_bullet_over_cap" || t.step === "weakest_bullet"), JSON.stringify(out.trimmed));
  // Exactly START minus the floors were removed.
  assert.equal(out.trimmed.length, START - FLOOR_BULLETS - CERTS);
  // Every certification entry, in order.
  assert.deepEqual(out.resume.certifications.map((c) => c.ref), ["cert_sql", "cert_prompt", "cert_ml", "cert_cloud", "cert_aws"]);
  // Every achievement entry, each keeping its bullet.
  assert.deepEqual(out.resume.achievements.map((a) => [a.ref, a.bullets.length]), [["ach_a", 1], ["ach_b", 1], ["ach_c", 1]]);
  // The Aczen floor: exactly 4 left; of the zero-score a2 and a4, the LATER (a4) went.
  assert.deepEqual(out.resume.experience.find((e) => e.ref === "exp_aczen")!.bullets.map((x) => x.ref), ["a1", "a2", "a3", "a5"]);
  // Student Tribe keeps its keyword bullet.
  assert.deepEqual(out.resume.experience.find((e) => e.ref === "exp_student_tribe")!.bullets.map((x) => x.ref), ["st2"]);
  // Every project keeps >= 4.
  for (const p of out.resume.projects) assert.ok(p.bullets.length >= PAGE_FIT_FLOORS.minBullets.projects, p.ref);
  // Skills, summary and education never change.
  assert.deepEqual([out.resume.skills, out.resume.summary, out.resume.education], [v24Like().skills, v24Like().summary, v24Like().education]);
});

test("one unit past the bullet floors is REFUSED, never a certification or achievement removed, and the refusal names both", () => {
  // A budget one below what the floors plus every entry need.
  const out = fitToOnePage(v24Like(), JD, (r) => units(r) <= FLOOR_BULLETS + CERTS - 1);
  // Not a fit: the caller refuses instead of saving page two or cutting an entry.
  assert.equal(out.fits, false);
  // Nothing but bullets went.
  assert.ok(out.trimmed.every((t) => t.step === "project_bullet_over_cap" || t.step === "weakest_bullet"), JSON.stringify(out.trimmed));
  // Every entry is still there.
  assert.deepEqual([out.resume.certifications.length, out.resume.achievements.length], [CERTS, 3]);
  // The two never-removed sections are named, so the operator sees which rule held.
  assert.ok(out.blockedBy.includes("certifications: never removed"), out.blockedBy.join("; "));
  // Same for achievements.
  assert.ok(out.blockedBy.includes("achievements: never removed"), out.blockedBy.join("; "));
  // The Aczen floor and skills are named as before.
  assert.ok(out.blockedBy.includes("exp_aczen: keeps >= 4 bullets") && out.blockedBy.includes("skills: never removed"));
});

test("withoutTrimmed applies a bullet trim to the tailor's ref profile shape too", () => {
  // A minimal ref-shaped profile (no text fields beyond the bullet refs).
  const refs = { experience: [{ ref: "e", bullets: [{ ref: "x", text: "t" }, { ref: "y", text: "u" }] }], projects: [], achievements: [], certifications: [{ ref: "c1", bullets: [] }] };
  // A bullet removal.
  const out = withoutTrimmed(refs, { step: "weakest_bullet", ref: "x" });
  // Exactly that bullet gone; the certification untouched.
  assert.deepEqual([out.experience[0]!.bullets.map((x) => x.ref), out.certifications.map((c) => c.ref)], [["y"], ["c1"]]);
});
