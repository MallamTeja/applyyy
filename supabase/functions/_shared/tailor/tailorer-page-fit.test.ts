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
