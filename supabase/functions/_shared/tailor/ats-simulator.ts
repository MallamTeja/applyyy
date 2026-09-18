// Offline ATS Resume Parse Simulator Engine.
//
// THE PURPOSE OF THIS MODULE:
// Simulates how Applicant Tracking Systems (ATS) ingest, parse, and score
// resume profiles against job postings offline without external API calls.
//
// DESIGN & ARCHITECTURE:
// Built to run entirely offline without network I/O, external dependencies,
// or nondeterministic LLM API calls. Provides fast, repeatable scoring.
//
// SCORE COMPUTATION ARCHITECTURE:
// 1. Keyword Extraction (50% weight):
//    Extracts technical terms, required skills, and core domain nouns from job.
//    Matches against resume text and identifies missing keywords.
// 2. Section Header Parsing (30% weight):
//    Detects standard ATS resume sections (Experience, Education, Skills,
//    Summary, Contact Information) to verify parseability.
// 3. Formatting Readability (20% weight):
//    Evaluates text density, clean character encoding, item completeness,
//    and structure clarity to ensure ATS parsers can digest content.

// Public interface for the ATS parse simulation result.
// Provides both the match percentage (0-100) and missing keyword details.
export interface AtsParseResult {
  // Overall ATS match score scaled from 0 to 100 percentage points.
  readonly parseScore: number;
  // Array of extracted job keywords not present in the candidate profile.
  readonly missingKeywords: string[];
}

// Internal interface for detailed sub-score breakdown during simulation.
// Useful for debugging, audit logging, and fine-grained score calculation.
interface AtsSubScores {
  // Sub-score measuring keyword match ratio (0 to 100).
  readonly keywordScore: number;
  // Sub-score measuring section header detection (0 to 100).
  readonly sectionHeaderScore: number;
  // Sub-score measuring document readability and formatting (0 to 100).
  readonly formattingScore: number;
}

// Standard English stop words to filter out during keyword extraction.
// Excludes non-distinctive common words, prepositions, conjunctions, and generic terms.
const ATS_STOP_WORDS: ReadonlySet<string> = new Set([
  // Core English articles and prepositions
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
  // Pronouns and conjunctions
  "any", "are", "aren't", "as", "at", "be", "because", "been", "before", "being",
  // Auxiliary verbs and determiners
  "below", "between", "both", "but", "by", "can", "cannot", "could", "did", "do",
  // Demonstratives and location words
  "does", "doing", "down", "during", "each", "few", "for", "from", "further", "had",
  // Modal verbs and state indicators
  "has", "have", "having", "he", "her", "here", "hers", "herself", "him", "himself",
  // Relative pronouns and possessives
  "his", "how", "i", "if", "in", "into", "is", "it", "its", "itself", "just", "me",
  // Quantifiers and comparison terms
  "more", "most", "my", "myself", "no", "nor", "not", "of", "off", "on", "once",
  // Prepositional modifiers
  "only", "or", "other", "our", "ours", "ourselves", "out", "over", "own", "same",
  // Subordinating conjunctions
  "she", "should", "so", "some", "such", "than", "that", "the", "their", "theirs",
  // Object pronouns and directions
  "them", "themselves", "then", "there", "these", "they", "this", "those", "through",
  // Time and spatial relation words
  "to", "too", "under", "until", "up", "very", "was", "we", "were", "what", "when",
  // Interrogatives and adverbs
  "where", "which", "while", "who", "whom", "why", "with", "would", "you", "your",
  // Possessive self references
  "yours", "yourself", "yourselves",
  // Generic job posting boilerplate words and verbs to exclude from keyword matching
  "ability", "able", "candidate", "candidates", "description", "duty", "duties",
  "employee", "experience", "experiences", "ideal", "job", "knowledge", "must",
  "need", "needed", "opportunity", "preferred", "qualifications", "required",
  "requirement", "requirements", "role", "responsibilities", "seeking", "skill",
  "skills", "strong", "team", "work", "working", "years", "year", "plus", "minimum",
  "looking", "skilled", "hiring", "join", "help", "build", "create", "manage",
  "lead", "develop", "support", "responsible", "position", "positions", "company",
  "business", "projects", "project", "want", "wanted", "looking for", "work with",
  "raw", "description_raw", "title", "company_name"
]);

// Standard ATS resume section keywords to search for during section header parsing.
// Each category represents a vital structural section expected by ATS parsers.
const STANDARD_SECTION_PATTERNS: Readonly<Record<string, RegExp>> = {
  // Contact information header or profile metadata field
  contact: /(?:contact|email|phone|address|location|linkedin|github|personal)/i,
  // Work experience and employment history section
  experience: /(?:experience|employment|work|history|career|positions|professional)/i,
  // Education, degrees, and academic background section
  education: /(?:education|degree|university|college|academic|school)/i,
  // Skills, technical competencies, and core strengths section
  skills: /(?:skill|skills|technologies|tech|competencies|expertise|proficiencies|tools)/i,
  // Summary, professional objective, or overview section
  summary: /(?:summary|objective|profile|about|overview|background|bio)/i,
};

// Recursively flattens any profile or job object into a single normalized text string.
// Handles strings, numbers, arrays, and arbitrary nested JSON objects safely.
//
// PARAMETERS AND RETURN VALUE:
// @param input - Untrusted input object, array, or primitive value.
// @returns Flattened plain text string representation of all content.
function extractRawText(input: unknown): string {
  // Check if input is null or undefined to prevent null dereference errors.
  if (input === null || input === undefined) {
    // Avoid null reference errors by returning empty string immediately.
    return "";
  }

  // Check if input is already a plain string.
  if (typeof input === "string") {
    // Plain string value extracted successfully, return unchanged.
    return input;
  }

  // Check if input is a numeric or boolean primitive value.
  if (typeof input === "number" || typeof input === "boolean") {
    // Convert numeric or boolean scalar value directly to string.
    return String(input);
  }

  // Check if input is an array containing multiple items.
  if (Array.isArray(input)) {
    // Process each array element recursively to aggregate nested text content.
    // Joins resulting array elements with space separators.
    return input.map((element) => extractRawText(element)).join(" ");
  }

  // Check if input is a non-null object with key-value properties.
  if (typeof input === "object") {
    // Initialize container array for object property text chunks.
    const chunks: string[] = [];

    // Safely extract object keys and property values.
    for (const [key, value] of Object.entries(input)) {
      // Exclude internal database/schema key suffixes like description_raw or id.
      if (key !== "description_raw" && key !== "id" && key !== "created_at" && key !== "raw") {
        // Include key name as text signal (e.g. section titles or property labels).
        chunks.push(key);
      }
      // Recursively extract text from nested property value.
      chunks.push(extractRawText(value));
    }

    // Join all collected property text chunks with spaces.
    return chunks.join(" ");
  }

  // Fallback case for any unsupported data type: return empty string safely.
  return "";
}

// Tokenizes raw text into clean, normalized individual words and technical terms.
// Preserves technical characters like '+' in C++ or '#' in C# or '.' in Node.js.
//
// PARAMETERS AND RETURN VALUE:
// @param text - Raw input text string.
// @returns Array of normalized lower-cased tokens.
function tokenizeText(text: string): string[] {
  // Guard against blank, null, or non-string text input parameters.
  if (!text || typeof text !== "string") {
    // Return empty token array for empty or invalid text inputs.
    return [];
  }

  // Convert raw text to lower case for consistent case-insensitive processing.
  const lowerText = text.toLowerCase();

  // Split text by whitespace and non-word delimiters while preserving tech symbols.
  // Regex matches words containing letters, numbers, and tech symbols like +, #, .
  const rawTokens = lowerText.match(/[a-z0-9+#.-]+/g) || [];

  // Initialize array to hold clean tokens that pass normalization filters.
  const cleanTokens: string[] = [];

  // Process each extracted raw token through sequential normalization filters.
  for (const rawToken of rawTokens) {
    // Trim leading and trailing punctuation marks except tech symbols + and #.
    const trimmed = rawToken.replace(/^[^a-z0-9+#]+|[^a-z0-9+#]+$/g, "");

    // Check if token became empty after removing punctuation boundaries.
    if (trimmed.length === 0) {
      // Skip empty token and continue loop.
      continue;
    }

    // Ignore single-character non-tech words (allow 'c' or 'r' programming languages).
    if (trimmed.length === 1 && trimmed !== "c" && trimmed !== "r") {
      // Skip irrelevant single letters like standalone 'a' or 'i'.
      continue;
    }

    // Check if token consists purely of numeric digits (e.g. year numbers or counts).
    if (/^\d+$/.test(trimmed)) {
      // Skip standalone numbers as they are not ATS domain skill keywords.
      continue;
    }

    // Check if token matches any entry in the ATS stop words dictionary.
    if (ATS_STOP_WORDS.has(trimmed)) {
      // Skip generic English or resume boilerplate stop word.
      continue;
    }

    // Token passed all validation filters; collect it for keyword analysis.
    cleanTokens.push(trimmed);
  }

  // Return final collected array of cleaned, normalized tokens.
  return cleanTokens;
}

// Extracts unique, high-value keywords from a job posting for ATS matching.
// Deduplicates terms and counts frequency to prioritize key job requirements.
//
// PARAMETERS AND RETURN VALUE:
// @param jobText - Full raw text extracted from job posting.
// @returns Deduplicated array of extracted job requirement keywords.
function extractJobKeywords(jobText: string): string[] {
  // Tokenize the full job posting text into clean normalized tokens.
  const tokens = tokenizeText(jobText);

  // Map data structure to track frequency count of each token in job description.
  const frequencyMap = new Map<string, number>();

  // Iterate over tokens to calculate occurrence frequencies.
  for (const token of tokens) {
    // Retrieve existing frequency count or initialize to 0 if absent.
    const currentCount = frequencyMap.get(token) || 0;
    // Increment frequency counter for current token.
    frequencyMap.set(token, currentCount + 1);
  }

  // Initialize array to store unique extracted job keywords.
  const uniqueKeywords: string[] = [];

  // Collect unique keyword tokens from frequency map keys.
  for (const [token] of frequencyMap.entries()) {
    // Push token to unique keyword array.
    uniqueKeywords.push(token);
  }

  // Sort unique keywords alphabetically to ensure deterministic output ordering.
  uniqueKeywords.sort((a, b) => a.localeCompare(b));

  // Return final sorted list of unique job keywords.
  return uniqueKeywords;
}

// Simulates ATS section header parsing by evaluating candidate profile structure.
// Checks for the presence of standard ATS resume sections.
//
// PARAMETERS AND RETURN VALUE:
// @param profile - Raw candidate profile object or text.
// @param profileText - Normalized text extracted from candidate profile.
// @returns Section header parse sub-score between 0 and 100.
function parseSectionHeaders(profile: unknown, profileText: string): number {
  // Counter tracking how many standard ATS sections were successfully detected.
  let detectedSectionsCount = 0;

  // Determine total number of standard section categories configured in pattern dictionary.
  const totalSectionsCount = Object.keys(STANDARD_SECTION_PATTERNS).length;

  // Container string for top-level object property keys if profile is an object.
  let profileKeysText = "";

  // Check if profile parameter is a non-null object for key inspection.
  if (typeof profile === "object" && profile !== null) {
    // Aggregate top-level object keys to detect section names defined as object keys.
    profileKeysText = Object.keys(profile).join(" ");
  }

  // Combine top-level profile keys text with full profile body text for regex matching.
  const combinedSearchText = `${profileKeysText} ${profileText}`;

  // Loop through each standard section pattern in the configuration map.
  for (const [, pattern] of Object.entries(STANDARD_SECTION_PATTERNS)) {
    // Execute regex match against combined profile keys and body text.
    if (pattern.test(combinedSearchText)) {
      // Increment count of detected sections when a pattern matches.
      detectedSectionsCount += 1;
    }
  }

  // Calculate ratio of detected standard sections relative to total checked sections.
  const sectionRatio = detectedSectionsCount / totalSectionsCount;

  // Convert calculated ratio into a 0 to 100 sub-score scale.
  const sectionScore = Math.round(sectionRatio * 100);

  // Return final section header parse sub-score value.
  return sectionScore;
}

// Evaluates formatting readability signals of the resume profile.
// Assesses text density, structural cleanliness, and absence of malformed data.
//
// PARAMETERS AND RETURN VALUE:
// @param profile - Untrusted candidate profile input.
// @param profileText - Normalized raw text of the profile.
// @returns Readability sub-score between 0 and 100.
function evaluateFormattingReadability(profile: unknown, profileText: string): number {
  // Check if profile or extracted text is null, undefined, or empty.
  if (!profile || !profileText || profileText.trim().length === 0) {
    // Return score of 0 for empty or unparseable profile content.
    return 0;
  }

  // Initialize base readability score starting at 100 points.
  let readabilityScore = 100;

  // Penalty Check 1: Insufficient content length (fewer than 30 characters).
  if (profileText.trim().length < 30) {
    // Deduct 40 score points for severely sparse content length.
    readabilityScore -= 40;
  }

  // Penalty Check 2: Detection of unprintable or corrupt control characters.
  // Regex matches control characters in ASCII range 0-31 (excluding tab and newline).
  const controlCharsMatch = profileText.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g);

  // Evaluate if control character matches were found in text.
  if (controlCharsMatch && controlCharsMatch.length > 0) {
    // Deduct 30 score points for corrupt control characters in resume text.
    readabilityScore -= 30;
  }

  // Penalty Check 3: Raw unstructured string input instead of structured profile object.
  if (typeof profile !== "object" || profile === null) {
    // Deduct 20 score points for unstructured string inputs lacking field markup.
    readabilityScore -= 20;
  }

  // Clamp computed readability score within valid 0 to 100 numeric bounds.
  const clampedScore = Math.max(0, Math.min(100, readabilityScore));

  // Return final formatting readability sub-score.
  return clampedScore;
}

// Computes keyword match score and identifies missing keywords.
// Compares job keywords against words found in candidate profile.
//
// PARAMETERS AND RETURN VALUE:
// @param profileText - Flattened raw text of candidate profile.
// @param jobKeywords - Extracted required job keywords.
// @returns Object containing keyword match sub-score and missing keywords array.
function evaluateKeywordMatch(
  profileText: string,
  jobKeywords: string[]
): { keywordScore: number; missingKeywords: string[] } {
  // Check if job posting contains zero extracted requirement keywords.
  if (!jobKeywords || jobKeywords.length === 0) {
    // Perfect keyword match (100) when no specific job requirements are stated.
    return { keywordScore: 100, missingKeywords: [] };
  }

  // Tokenize candidate profile text into clean normalized tokens.
  const profileTokens = tokenizeText(profileText);

  // Construct a Set from profile tokens for O(1) membership checking.
  const profileTokenSet = new Set<string>(profileTokens);

  // Initialize array to accumulate missing keywords not found in profile.
  const missingKeywords: string[] = [];

  // Counter tracking total number of matched job keywords.
  let matchedCount = 0;

  // Iterate over each extracted job requirement keyword.
  for (const keyword of jobKeywords) {
    // Perform exact token match check in profile token set.
    const isDirectMatch = profileTokenSet.has(keyword);

    // Perform case-insensitive substring match check for multi-word or compound terms.
    const isSubstringMatch = profileText.toLowerCase().includes(keyword.toLowerCase());

    // Evaluate whether keyword matched via direct token lookup or substring check.
    if (isDirectMatch || isSubstringMatch) {
      // Increment count of successfully matched job keywords.
      matchedCount += 1;
    } else {
      // Keyword missing from candidate profile; record it in missing keywords list.
      missingKeywords.push(keyword);
    }
  }

  // Calculate match ratio between matched keywords count and total job keywords.
  const matchRatio = matchedCount / jobKeywords.length;

  // Convert match ratio into a 0 to 100 keyword sub-score scale.
  const keywordScore = Math.round(matchRatio * 100);

  // Return keyword sub-score and array of missing requirement keywords.
  return {
    keywordScore,
    missingKeywords,
  };
}

// Core offline ATS Resume Parse Simulator function.
// Evaluates keyword extraction, section header parsing, and formatting readability
// to produce a comprehensive ATS match score (0-100%) and missing keywords list.
//
// PARAMETERS AND RETURN VALUE:
// @param profile - Candidate resume profile data (object, string, or any shape).
// @param job - Job posting data (object, string, or any shape).
// @returns Object containing parseScore (0-100) and missingKeywords array.
export function simulateAtsParse(profile: any, job: any): AtsParseResult {
  // Step 1: Flatten candidate profile input object into plain raw text string.
  const profileText = extractRawText(profile);

  // Step 2: Flatten job posting input object into plain raw text string.
  const jobText = extractRawText(job);

  // Step 3: Check edge case where candidate profile is completely empty or blank.
  if (!profileText || profileText.trim().length === 0) {
    // Extract job requirement keywords so missing keywords can still be reported.
    const extractedJobKeywords = extractJobKeywords(jobText);

    // Return match score 0 with all extracted job keywords marked as missing.
    return {
      parseScore: 0,
      missingKeywords: extractedJobKeywords,
    };
  }

  // Step 4: Extract normalized requirement keywords from the job posting text.
  const jobKeywords = extractJobKeywords(jobText);

  // Step 5: Calculate keyword match sub-score (50% weight) and missing keywords.
  const { keywordScore, missingKeywords } = evaluateKeywordMatch(profileText, jobKeywords);

  // Step 6: Calculate section header parsing sub-score (30% weight).
  const sectionHeaderScore = parseSectionHeaders(profile, profileText);

  // Step 7: Calculate formatting readability sub-score (20% weight).
  const formattingScore = evaluateFormattingReadability(profile, profileText);

  // Step 8: Compute weighted total ATS match score.
  // Formula: (Keyword Score * 0.50) + (Section Header Score * 0.30) + (Formatting Score * 0.20)
  const weightedScore = (keywordScore * 0.50) + (sectionHeaderScore * 0.30) + (formattingScore * 0.20);

  // Step 9: Round final weighted score to nearest integer and clamp to 0-100 range.
  const finalParseScore = Math.max(0, Math.min(100, Math.round(weightedScore)));

  // Structure diagnostic sub-scores object for auditing and inspection.
  const _subScores: AtsSubScores = {
    keywordScore,
    sectionHeaderScore,
    formattingScore,
  };

  // Void expression to suppress unused variable warning while preserving diagnostic structure.
  void _subScores;

  // Step 10: Return final simulation result with parseScore and missingKeywords.
  return {
    parseScore: finalParseScore,
    missingKeywords,
  };
}
