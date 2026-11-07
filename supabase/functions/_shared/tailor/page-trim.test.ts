// fitToOnePage: the content side of the one-page rule (Teja, 2026-11-07).
// The page measurement itself is proven against real Chromium in
// worker/test/page-fit-calibration.test.ts; here `fits` is a stand-in (a content budget), so
// every assertion is about WHAT is removed, in WHICH order, and WHERE it stops.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ResolvedResume } from "../contracts/shared-types.ts";
import { fitToOnePage, PAGE_FIT_FLOORS, TRIM_ORDER, withoutTrimmed } from "./page-trim.ts";

/** A resolved bullet whose text carries the given words (keywords make it strong). */
const b = (ref: string, text = "did routine things") => ({ ref, text, master_text: text });

/** A resume shaped like master v24: Aczen 5 bullets, Student Tribe 2, projects 6/3/4, 3 achievements, 3 certifications. */
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
      { ref: "proj_f1_predictor", bullets: [b("f1"), b("f2"), b("f3")] },
      { ref: "proj_applyy", bullets: [b("y1", "typescript"), b("y2"), b("y3"), b("y4")] },
    ],
    education: [{ ref: "edu_mlrit", bullets: [] }, { ref: "edu_tkr", bullets: [] }],
    achievements: [{ ref: "ach_a", bullets: [b("aa1")] }, { ref: "ach_b", bullets: [b("ab1")] }, { ref: "ach_c", bullets: [b("ac1")] }],
    certifications: [
      { ref: "cert_sql", label: "SQL postgres", description: null, bullets: [] },
      { ref: "cert_prompt", label: "Prompt Engineering", description: null, bullets: [] },
      { ref: "cert_ml", label: "Machine Learning", description: null, bullets: [] },
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
// Start: 5+2 + 6+3+4 + 3 bullets + 3 certs = 26 units.
const START = 26;
// Bullets left when every entry sits at its floor: Aczen 4, Student Tribe 1, projects 3+3+3, achievements 3.
const FLOOR_BULLETS = 4 + 1 + 3 + 3 + 3 + 3;

test("a resume that already fits is returned untouched", () => {
  // The input, kept to compare identity.
  const resume = v24Like();
  // Generous budget.
  const out = fitToOnePage(resume, JD, () => true);
  // Fits, nothing removed, the same object.
  assert.deepEqual([out.fits, out.trimmed, out.resume === resume], [true, [], true]);
});

test("TRIM_ORDER is Teja's ruling: projects over the cap, then weakest bullets, then certifications", () => {
  // The order is data; this pins it so a reorder is a deliberate, visible change.
  assert.deepEqual(TRIM_ORDER, ["project_bullet_over_cap", "weakest_bullet", "certification"]);
});

test("projects above 4 bullets are trimmed first, weakest (no keyword, latest) first", () => {
  // Budget allows exactly two removals.
  const out = fitToOnePage(v24Like(), JD, (r) => units(r) <= START - 2);
  // Both from proj_one_on_one (6 -> 4), the zero-score bullets, latest first: p6 then p4. Text carried for the UI.
  assert.deepEqual(out.trimmed, [
    { step: "project_bullet_over_cap", ref: "p6", text: "did routine things" },
    { step: "project_bullet_over_cap", ref: "p4", text: "did routine things" },
  ]);
});

test("then the weakest bullets anywhere, never below a floor; skills, summary and education untouched", () => {
  // Down to the bullet floors with all 3 certifications kept.
  const out = fitToOnePage(v24Like(), JD, (r) => units(r) <= FLOOR_BULLETS + 3);
  // Fits.
  assert.equal(out.fits, true);
  // The Aczen floor: exactly 4 left, and its keyword bullets survived; of the two
  // zero-score bullets a2 and a4, the LATER (a4) went.
  assert.deepEqual(out.resume.experience.find((e) => e.ref === "exp_aczen")!.bullets.map((x) => x.ref), ["a1", "a2", "a3", "a5"]);
  // Student Tribe keeps its keyword bullet.
  assert.deepEqual(out.resume.experience.find((e) => e.ref === "exp_student_tribe")!.bullets.map((x) => x.ref), ["st2"]);
  // Every project keeps >= 3.
  for (const p of out.resume.projects) assert.ok(p.bullets.length >= PAGE_FIT_FLOORS.minBullets.projects, p.ref);
  // Every achievement keeps its bullet.
  for (const a of out.resume.achievements) assert.equal(a.bullets.length, 1, a.ref);
  // Skills, summary and education never change.
  assert.deepEqual([out.resume.skills, out.resume.summary, out.resume.education], [v24Like().skills, v24Like().summary, v24Like().education]);
  // No certification went while a bullet above its floor remained.
  assert.equal(out.resume.certifications.length, 3);
});

test("certifications go last, weakest first, never below 2", () => {
  // Floors plus 2 certifications fits exactly.
  const out = fitToOnePage(v24Like(), JD, (r) => units(r) <= FLOOR_BULLETS + 2);
  // The last removal is a certification: the latest zero-score one.
  assert.deepEqual(out.trimmed.at(-1), { step: "certification", ref: "cert_ml", text: "Machine Learning" });
  // cert_sql (names a JD keyword) survives.
  assert.deepEqual(out.resume.certifications.map((c) => c.ref), ["cert_sql", "cert_prompt"]);
});

test("over one page at every floor fails CLOSED and names the floors that held", () => {
  // A budget below the floors.
  const out = fitToOnePage(v24Like(), JD, (r) => units(r) <= 5);
  // Not a fit: the caller refuses instead of saving page two.
  assert.equal(out.fits, false);
  // The Aczen floor is named.
  assert.ok(out.blockedBy.includes("exp_aczen: keeps >= 4 bullets"), out.blockedBy.join("; "));
  // The certification floor is named.
  assert.ok(out.blockedBy.includes("certifications: keeps >= 2"));
  // Skills are named as never removed.
  assert.ok(out.blockedBy.includes("skills: never removed"));
});

test("withoutTrimmed applies a trim item to the tailor's ref profile shape too", () => {
  // A minimal ref-shaped profile (no text fields beyond the bullet refs).
  const refs = { experience: [{ ref: "e", bullets: [{ ref: "x", text: "t" }, { ref: "y", text: "u" }] }], projects: [], achievements: [], certifications: [{ ref: "c1", bullets: [] }, { ref: "c2", bullets: [] }] };
  // A bullet removal, then a certification removal.
  const out = withoutTrimmed(withoutTrimmed(refs, { step: "weakest_bullet", ref: "x" }), { step: "certification", ref: "c2" });
  // Exactly those two gone.
  assert.deepEqual([out.experience[0]!.bullets.map((x) => x.ref), out.certifications.map((c) => c.ref)], [["y"], ["c1"]]);
});
