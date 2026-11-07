// ============================================================================
// AUDITOR AGENT ORCHESTRATOR MODULE
// ============================================================================
//
// This module provides high-level application auditing functions for the Auditor
// agent. It receives the master profile, resolved tailored resume, and optional raw
// tailor refs, invokes the anti-fabrication detector, and produces a structured
// AuditOutcome.
//
// Key Statuses Returned:
//   - 'audit_clean': All claims, skills, metrics, and bullet lines traceably resolve
//     to valid master nodes with zero detected hallucinations or misattributions.
//   - 'audit_flagged': At least one claim, metric, technology, or ref was untraceable,
//     misattributed, or unfaithful to the master profile.
// ============================================================================

// Import shared contract types for master profile, resolved resume, and findings
import type { AuditFinding, MasterProfile, ResolvedResume, TailoredProfile } from "../contracts/shared-types.ts";

// Import anti-fabrication detector function
import { detectAuditFindings } from "./detector.ts";

/**
 * Structured verdict returned by the Auditor agent.
 */
export interface AuditOutcome {
  /** True if zero audit findings were detected; false if any findings were flagged. */
  readonly isClean: boolean;

  /**
   * Target status for application row.
   * 'audit_clean' if no findings were flagged, otherwise 'audit_flagged'.
   */
  readonly status: "audit_clean" | "audit_flagged";

  /** Array of all findings (empty if clean). */
  readonly findings: readonly AuditFinding[];
}

/**
 * Audit an application by comparing its tailored profile against the master profile.
 *
 * @param master Pinned MasterProfile from database.
 * @param resume ResolvedResume sitting in application's tailored_profile column.
 * @param tailorRefs Optional raw TailoredProfile from application's tailor_refs column.
 * @param jobDescription The posting the row was tailored for (jobs.description_raw), or null/absent
 *   when unknown; only the jd_keyword_dropped check reads it (P2 #17, 2026-11-07).
 * @returns AuditOutcome containing status ('audit_clean' or 'audit_flagged') and findings.
 */
export function auditApplication(
  master: MasterProfile,
  resume: ResolvedResume,
  tailorRefs?: TailoredProfile | null,
  // Optional so every existing caller keeps its exact behaviour; the auditor passes it.
  jobDescription?: string | null,
): AuditOutcome {
  // Execute anti-fabrication detection logic across all profile nodes, plus the dropped-keyword check
  const findings = detectAuditFindings(master, resume, tailorRefs, jobDescription);

  // Profile is clean if zero findings were detected
  const isClean = findings.length === 0;

  // Determine target status based on cleanliness boolean
  const status = isClean ? "audit_clean" : "audit_flagged";

  // Return final verdict object containing status and findings
  return {
    isClean,
    status,
    findings,
  };
}

// Re-export detectAuditFindings helper for direct consumer access
export { detectAuditFindings } from "./detector.ts";
