// computeSkillGaps over the REAL master profile shape.
// Run with: node --test "supabase/functions/_shared/analytics/*.test.ts"
//
// WHY THIS FILE EXISTS: the first-ever production run of skill-gap (2026-11-01 10:38 UTC)
// crashed with "s.toLowerCase is not a function". The helper read `profile.skills` as
// string[], but MasterProfile.skills holds MasterSkill nodes ({ id, name, category }).
// No test fed it the real shape, so the cast to `any` hid the mismatch until production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSkillGaps } from "./skill-gap.ts";
import type { MasterProfile } from "../contracts/shared-types.ts";

test("real MasterSkill nodes match by name, case-insensitive; a malformed node is skipped, not thrown on", () => {
  // Shaped like live master_profiles.profile->'skills': one object per skill, the name inside.
  const skills = [
    // A well-formed node whose name matches a required skill exactly.
    { id: "skill_ts", name: "TypeScript", category: "Languages" },
    // A well-formed node in a different case, to prove the match ignores case.
    { id: "skill_pg", name: "postgresql", category: "Databases" },
    // A null slot: one bad node must not take the whole report down.
    null,
    // A non-string name: it must never be read as a skill.
    { id: "skill_bad", name: 42, category: "Broken" },
    // A blank name: it names nothing, so it must not count as a skill either.
    { id: "skill_blank", name: "   ", category: "Broken" },
  ];
  // Only `skills` matters here; the cast stands in for the rest of a real profile.
  const candidateProfile = { skills } as unknown as MasterProfile;

  // Two required skills the candidate has (one in another case) and one they lack.
  const gaps = computeSkillGaps({
    // Kubernetes is the only skill no well-formed node names.
    requiredSkills: ["TypeScript", "PostgreSQL", "Kubernetes"],
    // The profile carrying the real node shape plus the malformed entries.
    candidateProfile,
  });

  // Exactly the missing skill comes back, under its original spelling.
  assert.deepEqual(gaps, [{ skill: "Kubernetes", required: true }]);
});
