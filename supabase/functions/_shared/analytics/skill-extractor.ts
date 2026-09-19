// Define the extractRequiredSkills function
// It takes a raw string description and extracts a list of skills
// Returns an array of strings representing skills
export function extractRequiredSkills(descriptionRaw: string): string[] {
    // If the input is falsy, return an empty array
    if (!descriptionRaw) {
        // Return empty
        return [];
    }
    
    // Convert the entire string to lowercase for case-insensitive matching
    const lowerDesc = descriptionRaw.toLowerCase();
    
    // Define a basic set of common tech skills to look for
    // This is a naive extraction approach for now
    // We can add more skills later
    const knownSkills = [
        // Programming languages
        "javascript", "typescript", "python", "java", "c#", "c++", "go", "ruby", "rust",
        // Frameworks and libraries
        "react", "angular", "vue", "node.js", "django", "flask", "spring",
        // Databases
        "sql", "mysql", "postgresql", "mongodb", "redis",
        // Cloud and DevOps
        "aws", "azure", "gcp", "docker", "kubernetes", "ci/cd",
        // Tools
        "git", "linux"
    ];
    
    // Create an array to hold the found skills
    const found: string[] = [];
    
    // Loop over each known skill
    for (const skill of knownSkills) {
        // Check if the skill is present in the lowercased description
        // This is a simple substring check
        if (lowerDesc.includes(skill)) {
            // If it is, push it to the found array
            // We found a match
            found.push(skill);
        }
    }
    
    // Return the array of found skills
    // This will be used to compute gaps
    return found;
}
