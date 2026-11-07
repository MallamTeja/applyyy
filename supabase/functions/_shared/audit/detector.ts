// ============================================================================
// ANTI-FABRICATION DETECTOR MODULE
// ============================================================================
//
// This module implements the core claim-matching and hallucination-detection
// logic for the Auditor agent. It compares every node and line in a tailored
// profile (ResolvedResume / TailoredProfile) against the pinned master profile
// (MasterProfile).
//
// Grounding checks performed by this detector:
//   1. Master Profile Ambiguity Check: Ensure no duplicate NodeIds exist in master.
//   2. Skill Grounding Check: Ensure every skill ref exists in master and skill name matches.
//   3. Parent Grounding Check: Ensure experience, project, education, achievement,
//      and certification entry refs exist in master.
//   4. Bullet Ref & Misattribution Check: Ensure every bullet ref exists in master
//      AND is rendered beneath its true master parent node (misattributed bullet detection).
//   5. Metric & Content Fidelity Check: Ensure numbers and technology tokens in bullet rewordings
//      are present in the master bullet text, candidate skills, or allowable rhetorical vocabulary.
//   6. Summary Grounding Check: Ensure summary refs resolve to valid master nodes and prose is grounded.
// ============================================================================

// Import contract types from shared-types module
import type {
  // Audit finding type definition
  AuditFinding,
  // Master profile shape type
  MasterProfile,
  // Master bullet shape type
  MasterBullet,
  // Node ID string type alias
  NodeId,
  // Resolved resume shape type
  ResolvedResume,
  // Tailored profile shape type
  TailoredProfile,
} from "../contracts/shared-types.ts";
// The posting's keywords and the one word-bounded matching rule the ATS score uses (jd_keyword_dropped).
import { extractJdKeywords, keywordAppearsIn } from "../tailor/jd-keywords.ts";
// Stored postings may be raw HTML; the check reads their text (N1).
import { postingText } from "../tailor/posting-text.ts";

/**
 * Union of legal audit finding kinds derived from AuditFinding.
 */
export type AuditFindingKind = AuditFinding['kind'];

/**
 * Rhetorical and structural words permitted in bullet rewordings.
 * These carry no factual weight and can be safely introduced by tailoring.
 *
 * ALLOWLIST DESIGN:
 * Any word not in this set and not present in master bullet text or skills
 * is treated as an ungrounded claim or technology token.
 *
 * Exported (2026-10-31) so the review page's AI box can tell the model which words pass,
 * from this one list rather than a copy that drifts from what the auditor enforces.
 */
export const ALLOWED_RHETORICAL_WORDS: ReadonlySet<string> = new Set([
  // Articles and prepositions
  "a", "an", "the", "and", "or", "for", "with", "in", "of", "to", "on", "at",
  // Conjunctions and relational tokens
  "by", "as", "from", "into", "that", "which", "this", "its", "it", "over",
  // Comparatives and scope words
  "across", "per", "via", "than", "then", "while", "within", "through", "plus",
  // Framing verbs describing software engineering activities
  "designed", "developed", "implemented", "shipped", "delivered", "created",
  // Technical execution action verbs
  "wrote", "engineered", "handled", "serving", "supporting", "powering",
  // Deployment and usage action verbs
  "enabling", "using", "used", "including", "built", "deployed",
  // Application scale and scope framing terms
  "production", "end", "full", "stack", "based", "backed", "side", "scale",
  // Architectural entity nouns
  "platform", "application", "app", "service", "system", "portal", "project",
  // Interface and feature nouns
  "site", "api", "apis", "endpoint", "endpoints", "feature", "features",
  // User and traffic domain nouns
  "users", "user", "requests", "students", "services",
]);

/**
 * Tokenize a given string into lowercase word tokens, stripping punctuation.
 *
 * @param text The input string to tokenize.
 * @returns An array of lowercase string tokens.
 */
export function tokenizeText(text: string): string[] {
  // Convert text string to lowercase
  const lower = text.toLowerCase();

  // Split string using non-alphanumeric characters as delimiters
  const rawTokens = lower.split(/[^a-z0-9]+/);

  // Filter out any zero-length empty string elements produced by punctuation
  const validTokens = rawTokens.filter((token) => token.length > 0);

  // Return the array of valid token strings
  return validTokens;
}

/**
 * Extract digit sequences (metrics) from a given string.
 * Strips comma separators (e.g. "1,000" -> "1000") before extracting runs of digits.
 *
 * @param text The text from which to extract numbers.
 * @returns Array of string representations of numbers.
 */
export function extractMetrics(text: string): string[] {
  // Strip comma separators between numeric digits (e.g., convert "1,000" to "1000")
  const cleaned = text.replace(/(\d),(?=\d)/g, "$1");

  // Extract all contiguous runs of digit characters
  const matches = cleaned.match(/\d+/g);

  // Return extracted digit strings array or an empty array if no matches found
  return matches ?? [];
}

/**
 * Rule 5, the content and metric fidelity check, for ONE bullet: the numbers and the words in
 * `text` that its master bullet, the master's skill names and the allowlist do not supply.
 *
 * One function so the auditor and the review page's AI box (apps/web aiEdit.ts) apply the same
 * definition of "grounded" (2026-10-31). Order and duplicates are kept exactly as the auditor's
 * finding reasons have always printed them.
 *
 * @param text The bullet text being judged.
 * @param masterText The master bullet it rewords.
 * @param skillTokens Tokens of every master skill name (MasterIndex.skillTokens).
 * @returns The ungrounded metrics and the ungrounded word tokens; both empty means grounded.
 */
export function bulletGroundingGaps(
  text: string,
  masterText: string,
  skillTokens: ReadonlySet<string>,
): { readonly metrics: readonly string[]; readonly terms: readonly string[] } {
  // Every number the master bullet states.
  const masterMetrics = new Set(extractMetrics(masterText));
  // Numbers in the text the master bullet does not state: invented or inflated.
  const metrics = extractMetrics(text).filter((m) => !masterMetrics.has(m));
  // The master bullet's own words are always allowed.
  const allowedTokens = new Set(tokenizeText(masterText));
  // So is any word of any master skill name.
  for (const token of skillTokens) allowedTokens.add(token);
  // And the fixed rhetorical vocabulary.
  for (const token of ALLOWED_RHETORICAL_WORDS) allowedTokens.add(token);
  // Words that are not numbers and come from none of the three sources.
  const terms = tokenizeText(text).filter((token) => !/^\d+$/.test(token) && !allowedTokens.has(token));
  // Both lists; the caller decides how to report them.
  return { metrics, terms };
}

/**
 * Structure holding indexed master profile nodes for fast O(1) lookup.
 */
export interface MasterIndex {
  /** Map of bullet id -> { bullet, parentId } */
  readonly bullets: ReadonlyMap<NodeId, { readonly bullet: MasterBullet; readonly parentId: NodeId }>;
  /** Map of parent id -> parent section kind */
  readonly parentNodes: ReadonlyMap<NodeId, string>;
  /** Set of skill ids in master */
  readonly skillIds: ReadonlySet<NodeId>;
  /** Map of skill id -> skill name */
  readonly skillNames: ReadonlyMap<NodeId, string>;
  /** Set of all valid skill name tokens in master */
  readonly skillTokens: ReadonlySet<string>;
  /** Set of all master node IDs (global ID space) */
  readonly allIds: ReadonlySet<NodeId>;
}

/**
 * Build an index of all nodes in a MasterProfile.
 *
 * @param master The master profile to index.
 * @returns A structured MasterIndex object.
 */
export function buildMasterIndex(master: MasterProfile): MasterIndex {
  // Initialize map of bullet ID to its bullet object and parent node ID
  const bullets = new Map<NodeId, { bullet: MasterBullet; parentId: NodeId }>();

  // Initialize map of top-level parent node ID to section kind
  const parentNodes = new Map<NodeId, string>();

  // Initialize set of all skill IDs
  const skillIds = new Set<NodeId>();

  // Initialize map of skill ID to skill name
  const skillNames = new Map<NodeId, string>();

  // Initialize set of all skill name tokens
  const skillTokens = new Set<string>();

  // Initialize set tracking all IDs in the global node space
  const allIds = new Set<NodeId>();

  // Iterate over master skills to build skill lookups
  for (const skill of master.skills) {
    // Add skill ID to skill set
    skillIds.add(skill.id);

    // Map skill ID to canonical skill name
    skillNames.set(skill.id, skill.name);

    // Track skill ID in global ID set
    allIds.add(skill.id);

    // Tokenize skill name
    const tokens = tokenizeText(skill.name);

    // Add each skill name token to skill tokens set
    for (const token of tokens) {
      // Add individual token string to set
      skillTokens.add(token);
    }
  }

  // Check if master profile contains summary node
  if (master.summary !== null) {
    // Add summary node ID to global ID set
    allIds.add(master.summary.id);
  }

  // Helper function to index parent section entries and their nested bullets
  const indexParents = (
    // Parents array
    parents: readonly { readonly id: NodeId; readonly bullets: readonly MasterBullet[] }[],
    // Section kind string
    kind: string,
  ): void => {
    // Loop through each parent item in the section
    for (const parent of parents) {
      // Map parent ID to section kind
      parentNodes.set(parent.id, kind);

      // Track parent ID in global ID set
      allIds.add(parent.id);

      // Loop through nested bullets under this parent entry
      for (const bullet of parent.bullets) {
        // Map bullet ID to bullet object and parent node ID
        bullets.set(bullet.id, { bullet, parentId: parent.id });

        // Track bullet ID in global ID set
        allIds.add(bullet.id);
      }
    }
  };

  // Index experience parent nodes and bullets
  indexParents(master.experience, "experience");

  // Index projects parent nodes and bullets
  indexParents(master.projects, "projects");

  // Index education parent nodes and bullets
  indexParents(master.education, "education");

  // Index achievements parent nodes and bullets
  indexParents(master.achievements, "achievements");

  // Index certifications parent nodes and bullets
  indexParents(master.certifications, "certifications");

  // Return completed master index object
  return {
    // Bullets map reference
    bullets,
    // Parent nodes map reference
    parentNodes,
    // Skill IDs set reference
    skillIds,
    // Skill names map reference
    skillNames,
    // Skill tokens set reference
    skillTokens,
    // All IDs set reference
    allIds,
  };
}

/**
 * Detect all anti-fabrication violations and hallucinations in a tailored profile.
 *
 * Compares the tailored resume (`ResolvedResume`) and raw tailor refs (`TailoredProfile`)
 * against the source master profile (`MasterProfile`).
 *
 * @param master The pinned master profile.
 * @param resume The resolved tailored resume.
 * @param tailorRefs Optional raw tailored profile containing raw refs.
 * @param jobDescription The posting, or null/absent; without it the jd_keyword_dropped check is skipped.
 * @returns Array of AuditFinding objects describing any detected discrepancies.
 */
export function detectAuditFindings(
  master: MasterProfile,
  resume: ResolvedResume,
  tailorRefs?: TailoredProfile | null,
  // Optional: callers before 2026-11-07 pass three arguments and keep their exact findings.
  jobDescription?: string | null,
): AuditFinding[] {
  // Initialize findings accumulator array
  const findings: AuditFinding[] = [];

  // Step 1: Build lookup index for master profile
  const index = buildMasterIndex(master);

  // The posting's keywords, read once, by the SAME vocabulary that fills selected_jd_keywords, so the
  // finding speaks about the words the ATS score counts. No posting: nothing to keep, no check.
  // Read as TEXT (N1, 2026-11-07): a stored HTML posting's attributes and footer must never be read as
  // the posting's words.
  const jdKeywords = jobDescription ? extractJdKeywords(postingText(jobDescription) ?? "") : [];

  // Step 2: Audit Skills Section
  // Loop through skills in tailored resume
  for (let i = 0; i < resume.skills.length; i++) {
    // Get skill entry at index i
    const skill = resume.skills[i];

    // Guard against undefined elements
    if (!skill) continue;

    // Construct path identifier string for audit finding
    const path = `skills[${i}]`;

    // Check if skill ref exists in master skills index
    if (!index.skillIds.has(skill.ref)) {
      // Record unresolved skill reference finding
      findings.push({
        // Finding kind for unresolved reference
        kind: "unresolved_ref",
        // Path in tailored profile
        path,
        // Claim string quoted for reviewer
        claim: skill.name,
        // Explanation reason string
        reason: `Skill ref "${skill.ref}" does not exist in master profile`,
        // Auditor confidence score
        confidence: 1.0,
      });
    } else {
      // Fetch canonical master skill name
      const masterName = index.skillNames.get(skill.ref);

      // Verify skill name matches canonical master skill name
      if (masterName && masterName.toLowerCase() !== skill.name.toLowerCase()) {
        // Record unfaithful skill name rewording finding
        findings.push({
          // Finding kind for unfaithful rewording
          kind: "unfaithful_rewording",
          // Path in tailored profile
          path,
          // Claim string quoted for reviewer
          claim: skill.name,
          // Explanation reason string
          reason: `Skill name "${skill.name}" differs from master skill name "${masterName}"`,
          // Auditor confidence score
          confidence: 0.9,
        });
      }
    }
  }

  // Step 3: Audit Bullet-Bearing Parent Sections (Experience, Projects, Education, Achievements, Certifications)
  // Higher order helper function for auditing parent sections
  const auditParentSection = <T extends { readonly ref: NodeId; readonly bullets: readonly { readonly ref: NodeId; readonly text: string; readonly master_text?: string }[] }>(
    // Parent section items array
    items: readonly T[],
    // Section name string
    sectionName: string,
    // Claim label generator callback
    getClaimLabel: (item: T) => string,
  ): void => {
    // Loop through each item in parent section
    for (let i = 0; i < items.length; i++) {
      // Get section entry at index i
      const item = items[i];

      // Guard against undefined elements
      if (!item) continue;

      // Construct parent section path identifier
      const parentPath = `${sectionName}[${i}]`;

      // Check if parent entry ref exists in master index
      if (!index.parentNodes.has(item.ref)) {
        // Record unresolved parent entry reference finding
        findings.push({
          // Finding kind for unresolved reference
          kind: "unresolved_ref",
          // Path in tailored profile
          path: parentPath,
          // Claim string
          claim: getClaimLabel(item),
          // Explanation reason
          reason: `${sectionName} entry ref "${item.ref}" does not exist in master profile`,
          // Confidence score
          confidence: 1.0,
        });
      }

      // Loop through each bullet under this parent entry
      for (let j = 0; j < item.bullets.length; j++) {
        // Get bullet entry at index j
        const bullet = item.bullets[j];

        // Guard against undefined elements
        if (!bullet) continue;

        // Construct bullet path identifier
        const bulletPath = `${parentPath}.bullets[${j}]`;

        // Fetch bullet info from master index
        const masterBulletInfo = index.bullets.get(bullet.ref);

        // Handle case where bullet ref is absent from master
        if (!masterBulletInfo) {
          // Bullet ref does not exist anywhere in master profile
          findings.push({
            // Finding kind
            kind: "unresolved_ref",
            // Bullet path
            path: bulletPath,
            // Bullet text claim
            claim: bullet.text,
            // Reason explanation
            reason: `Bullet ref "${bullet.ref}" does not exist in master profile`,
            // Confidence score
            confidence: 1.0,
          });
        } else {
          // Check for MISATTRIBUTION: Bullet exists in master, but belongs to a different parent node
          if (masterBulletInfo.parentId !== item.ref) {
            // Record misattributed bullet finding naming claimed and actual parent refs
            findings.push({
              // Misattributed bullet kind
              kind: "misattributed_bullet",
              // Bullet path
              path: bulletPath,
              // Bullet claim text
              claim: bullet.text,
              // Reason explanation
              reason: `Bullet ref "${bullet.ref}" belongs to master parent "${masterBulletInfo.parentId}" but was rendered under "${item.ref}"`,
              // Confidence score
              confidence: 1.0,
              // Referenced bullet node ID
              ref: bullet.ref,
              // Claimed parent ref rendered under
              claimed_parent_ref: item.ref,
              // Actual parent ref in master profile
              actual_parent_ref: masterBulletInfo.parentId,
            });
          }

          // Fidelity is checked against the PINNED master's bullet only, never the resume's own master_text copy (it lives in the audited object, so it could agree with a fabrication; 2026-11-04).
          const masterText = masterBulletInfo.bullet.text;

          // Rule 5 in its one shared definition (also run by the review page's AI box).
          const gaps = bulletGroundingGaps(bullet.text, masterText, index.skillTokens);

          // Invented or inflated metrics.
          const inventedMetrics = gaps.metrics;

          // If invented metrics exist, push audit finding
          if (inventedMetrics.length > 0) {
            // Record unfaithful metric finding
            findings.push({
              // Unfaithful rewording kind
              kind: "unfaithful_rewording",
              // Bullet path
              path: bulletPath,
              // Claim text
              claim: bullet.text,
              // Reason explanation
              reason: `Bullet text introduces ungrounded metric(s): ${inventedMetrics.join(", ")}`,
              // Confidence score
              confidence: 0.95,
            });
          }

          // Words the master bullet, the master skills and the allowlist do not supply.
          const ungroundedTokens = gaps.terms;

          // If ungrounded terms exist, push audit finding
          if (ungroundedTokens.length > 0) {
            // Record ungrounded technology / claim token finding
            findings.push({
              // Unfaithful rewording kind
              kind: "unfaithful_rewording",
              // Bullet path
              path: bulletPath,
              // Claim text
              claim: bullet.text,
              // Reason explanation
              reason: `Bullet text contains ungrounded term(s) not found in master: ${ungroundedTokens.join(", ")}`,
              // Confidence score
              confidence: 0.85,
            });
          }

          // JD KEYWORD DROPPED (P2 #17, Teja ruling A 2026-11-07): a posting keyword the PINNED master
          // bullet has and the tailored bullet lost. keywordAppearsIn on both sides, so "Go" is not
          // credited from "Google" and a master "C" never stands in for a posting's "C++".
          const droppedKeywords = jdKeywords.filter((keyword) => keywordAppearsIn(keyword, masterText) && !keywordAppearsIn(keyword, bullet.text));

          // One finding per bullet, naming every keyword it lost.
          if (droppedKeywords.length > 0) {
            // Record the dropped-keyword finding; it flags the row for individual review by design.
            findings.push({
              // The kind added for this check
              kind: "jd_keyword_dropped",
              // Bullet path
              path: bulletPath,
              // The tailored text, as written, so the reviewer sees what lost the word
              claim: bullet.text,
              // The words to put back
              reason: `Bullet dropped posting keyword(s) the master bullet has: ${droppedKeywords.join(", ")}`,
              // Deterministic: both sides are matched by the same rule
              confidence: 1.0,
              // The same words as data, so the review page labels them without parsing `reason` (peer 3, 2026-11-07)
              keywords: droppedKeywords,
            });
          }
        }
      }
    }
  };

  // Run audit on experience section
  auditParentSection(resume.experience, "experience", (exp) => `${exp.company} - ${exp.role}`);

  // Run audit on projects section
  auditParentSection(resume.projects, "projects", (proj) => proj.name);

  // Run audit on education section
  auditParentSection(resume.education, "education", (edu) => `${edu.institution} - ${edu.degree}`);

  // Run audit on achievements section
  auditParentSection(resume.achievements, "achievements", (ach) => ach.label);

  // Run audit on certifications section
  auditParentSection(resume.certifications, "certifications", (cert) => cert.label);

  // Step 4: Audit Summary Section if present
  if (resume.summary !== null && resume.summary.length > 0) {
    // Path identifier for summary section
    const summaryPath = "summary";

    // Check raw tailor refs if provided
    if (tailorRefs && tailorRefs.summary) {
      // Verify summary has non-empty references
      if (tailorRefs.summary.refs.length === 0) {
        // Record missing summary references finding
        findings.push({
          // Summary unsupported kind
          kind: "summary_unsupported",
          // Summary path
          path: summaryPath,
          // Claim text
          claim: resume.summary,
          // Reason explanation
          reason: "Summary paragraph declares zero supporting master references",
          // Confidence score
          confidence: 0.9,
        });
      }

      // The PICKED summary variant's paragraph id (pending #11, 2026-11-07): the owner's own text, so
      // citable, exactly as the validator rules it. An unpicked variant stays uncitable.
      const pickedVariantSummaryId = (master.summary_variants ?? []).find((variant) => variant.id === tailorRefs.summary_variant)?.summary.id;

      // Check each declared reference in summary.refs
      for (const ref of tailorRefs.summary.refs) {
        // Verify reference exists in master profile global ID space, or is the picked variant's paragraph
        if (!index.allIds.has(ref) && ref !== pickedVariantSummaryId) {
          // Record invalid summary node reference finding
          findings.push({
            // Summary unsupported kind
            kind: "summary_unsupported",
            // Summary path
            path: summaryPath,
            // Claim text
            claim: resume.summary,
            // Reason explanation
            reason: `Summary references node ID "${ref}" which does not exist in master profile`,
            // Confidence score
            confidence: 0.95,
          });
        }
      }
    }
  }

  // Return accumulated audit findings array
  return findings;
}
