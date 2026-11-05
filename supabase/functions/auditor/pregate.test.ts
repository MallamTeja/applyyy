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
import { auditorPreGateDrop, type AuditorJobEmbed } from "./pregate.ts";
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

