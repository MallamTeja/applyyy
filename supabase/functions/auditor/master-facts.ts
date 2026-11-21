// The auditor's master-facts gate (tailor #5 parcel 1, P0 2026-11-21; findings doc section 7: "Auditor: compares
// role, company and dates with the master on every row").
//
// WHY IT EXISTS: the validator copies every display field (company, role, dates, school, award label) from the master,
// so a FRESH tailoring cannot misstate one. But a stored tailored_profile is only data: FamPay (master v39) reached
// Teja with the Aczen role retitled "Data Analyst Intern" by another write path, and the auditor said nothing, because
// no check compared printed facts with the master. Background checks compare titles and dates with HR records, so a
// wrong one is the costliest line on the page. This gate compares every printed fact with the PINNED master, once more,
// as the last agent before a human.
//
// WHAT PASSES: a field equal to the master's (nullable fields compared as `?? null`), an Aczen role from the
// validator's allow-list (EXPERIENCE_TITLE_ALLOW_LIST), and a headline that is the master's own, a variant's own, or
// passes checkHeadline against the job title.
//
// WHY ONLY THE AUDITOR, NOT checkContentRules: checkContentRules is also the web edit gate (pageFitEdit.ts), and Teja's
// chat `set_role` (2026-11-11) legitimately prints a title he dictated. The auditor only sees fresh tailor output
// (status `tailored`), never a human edit, so this gate can never refuse his own words.
//
// PURE: no Deno API, so node --test runs it.

// The contract shapes.
import type { MasterProfile, ResolvedResume } from "../_shared/contracts/shared-types.ts";
// The titles an experience may print instead of the master role (one list, shared with the validator).
import { EXPERIENCE_TITLE_ALLOW_LIST } from "../_shared/tailor/validator.ts";
// The headline rule (job title only, no seniority, not bare Intern).
import { checkHeadline } from "../_shared/tailor/content-rules.ts";

// The verdict: the broken facts named, or null when every printed fact is the master's.
export type AuditorMasterFactsDrop = { readonly code: "master_facts"; readonly reason: string } | null;

// One entry kind's display fields: the section, its master list, and the fields to compare.
type FieldCheck = { readonly section: string; readonly printed: readonly { readonly ref: string }[]; readonly master: readonly { readonly id: string }[]; readonly fields: readonly string[] };

// Compare one value pair; nullable fields: an absent key and null both read as null (the validator's nullIfAbsent).
function sameValue(printed: unknown, held: unknown): boolean {
  // `??` folds undefined onto null on both sides; anything else compares exactly.
  return (printed ?? null) === (held ?? null);
}

// The gate. Throws on a missing resume or master (the caller's catch makes that a per-row failure, never a pass).
export function auditorMasterFactsDrop(resume: ResolvedResume | null, master: MasterProfile | null, jobTitle: string | null): AuditorMasterFactsDrop {
  // Nothing to compare is not "faithful" (CLAUDE.md section 6).
  if (resume === null || resume === undefined) throw new Error("auditor master facts: no resolved resume for this row");
  // No master: every comparison would pass vacuously.
  if (master === null || master === undefined) throw new Error("auditor master facts: no pinned master for this row");
  // Every broken fact.
  const broken: string[] = [];
  // Identity lines the validator copies verbatim (the headline has its own rule below).
  for (const field of ["full_name", "email", "phone", "location"] as const) {
    // A changed name or contact line is a different person on paper.
    if (!sameValue(resume.identity[field], master.identity[field])) broken.push(`identity.${field}: "${resume.identity[field]}" is not the master's "${master.identity[field]}"`);
  }
  // Each section's printed entries against the master entry with the same id.
  const checks: readonly FieldCheck[] = [
    // Role is checked separately (the allow-list).
    { section: "experience", printed: resume.experience, master: master.experience, fields: ["company", "location", "start_display", "end_display"] },
    // The project's name and dates.
    { section: "projects", printed: resume.projects, master: master.projects, fields: ["name", "start_display", "end_display"] },
    // The degree line.
    { section: "education", printed: resume.education, master: master.education, fields: ["institution", "degree", "field", "start_display", "end_display", "grade_display"] },
    // "Winner" must not become "International Winner".
    { section: "achievements", printed: resume.achievements, master: master.achievements, fields: ["label", "description"] },
    // The credential's name and issuer.
    { section: "certifications", printed: resume.certifications, master: master.certifications, fields: ["label", "description"] },
  ];
  // Each section.
  for (const check of checks) {
    // Each printed entry.
    for (const entry of check.printed) {
      // Its master node by id.
      const held = check.master.find((node) => node.id === entry.ref) as Record<string, unknown> | undefined;
      // An entry the master does not hold is invented outright.
      if (held === undefined) { broken.push(`${check.section}[${entry.ref}]: not in the master`); continue; }
      // Each display field.
      for (const field of check.fields) {
        // The printed value.
        const value = (entry as unknown as Record<string, unknown>)[field];
        // Anything but the master's own value.
        if (!sameValue(value, held[field])) broken.push(`${check.section}[${entry.ref}].${field}: "${value}" is not the master's "${held[field]}"`);
      }
    }
  }
  // Roles: the master's own, or a title the allow-list names for that experience.
  for (const entry of resume.experience) {
    // Its master node (an unknown one is already named above).
    const held = master.experience.find((node) => node.id === entry.ref);
    // Skip what was already reported.
    if (held === undefined) continue;
    // The master role, or an allow-listed title.
    const allowed = entry.role === held.role || (EXPERIENCE_TITLE_ALLOW_LIST[entry.ref] ?? []).includes(entry.role);
    // The FamPay case.
    if (!allowed) broken.push(`experience[${entry.ref}].role: "${entry.role}" is neither the master's "${held.role}" nor an allowed title`);
  }
  // The headline: the owner's own words pass as they are; anything else must pass the headline rule.
  const headline = resume.identity.headline ?? null;
  // The owner's headlines: the master's and each variant's.
  const owned = [master.identity.headline ?? null, ...(master.summary_variants ?? []).map((variant) => variant.headline)];
  // Not the owner's: judged against the job title.
  if (headline !== null && !owned.includes(headline)) {
    // The rule's reason, or null.
    const reason = checkHeadline(headline, jobTitle);
    // Named.
    if (reason !== null) broken.push(reason);
  }
  // Every broken fact in one reason, for the human who reads the event.
  return broken.length === 0 ? null : { code: "master_facts", reason: broken.join("; ") };
}
