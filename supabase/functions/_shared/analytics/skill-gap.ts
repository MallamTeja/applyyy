// Import MasterProfile for typing candidate data, and MasterSkill for the node each skills entry is
import type { MasterProfile, MasterSkill } from "../contracts/shared-types.ts";

// Define the shape of a skill gap entry
// Represents a missing skill for a particular job
export interface SkillGapEntry {
    // The name of the missing skill
    skill: string;
    // Whether it was required or just a good to have
    required: boolean;
}

// Define the input parameters for computeSkillGaps
export interface ComputeSkillGapParams {
    // The required skills for the job
    requiredSkills: string[];
    // The candidate's master profile
    candidateProfile: MasterProfile | null;
}

// Compute the skill gaps by diffing required skills and candidate skills
// Returns an array of SkillGapEntry
export function computeSkillGaps(params: ComputeSkillGapParams): SkillGapEntry[] {
    // Destructure the parameters for easy access
    const { requiredSkills, candidateProfile } = params;
    
    // If no candidate profile exists, they are missing all required skills
    if (!candidateProfile) {
        // Map required skills to gap entries
        return requiredSkills.map(skill => ({
            // Set the skill name
            skill,
            // Mark it as required
            required: true
        }));
    }

    // Extract candidate skills from the profile, defaulting to empty array if missing.
    // Each entry is a MasterSkill node ({ id, name, category }), NOT a bare string: the old
    // `as any` + string[] reading crashed the first production run (2026-11-01, "s.toLowerCase
    // is not a function"). The type is the caller's claim about a JSON row, so the shape is
    // still checked here; a non-array `skills` means no known skills, so every gap is reported.
    const skillNodes: readonly MasterSkill[] = Array.isArray(candidateProfile.skills) ? candidateProfile.skills : [];

    // Convert candidate skill names to lowercase for case-insensitive comparison
    // This ensures robust matching
    // flatMap lets one malformed node (null, a non-string or blank name) drop out on its own
    // instead of throwing and losing the whole report, and never lets a non-string count as a skill.
    const candidateSkillsLower = skillNodes.flatMap((node) =>
        // Only a non-blank string name is a skill; `?.` survives a null slot in the stored array.
        typeof node?.name === "string" && node.name.trim() !== "" ? [node.name.toLowerCase()] : []);

    // Create an array to hold the computed gaps
    const gaps: SkillGapEntry[] = [];
    
    // Iterate over each required skill
    for (const reqSkill of requiredSkills) {
        // Convert required skill to lowercase
        const reqSkillLower = reqSkill.toLowerCase();
        
        // Check if the candidate does NOT have this skill
        // This is a simple exact match check
        if (!candidateSkillsLower.includes(reqSkillLower)) {
            // Add to gaps array if missing
            // This is a gap
            gaps.push({
                // The original skill name
                skill: reqSkill,
                // Mark it as required
                required: true
            });
        }
    }
    
    // Return the computed gaps
    // This lists all skills missing from the candidate's profile
    return gaps;
}
