// ============================================================================
// AUDITOR UNIT TESTS & ANTI-FABRICATION VALIDATOR SUITE
// ============================================================================
//
// Unit tests for the Auditor agent anti-fabrication validator module.
// Executes under Node.js native test runner via: node --test "supabase/functions/_shared/audit/*.test.ts"
//
// Architecture & Validation Rules Tested:
//   1. Grounded Profile Acceptance: A valid resume derived strictly from master profile nodes
//      must be assigned status 'audit_clean' with zero findings.
//   2. Unresolved Ref Detection: References to non-existent skills or bullets must generate
//      'unresolved_ref' findings and result in status 'audit_flagged'.
//   3. Parent Node Misattribution: Rendering a bullet under an incorrect parent section or entry
//      must produce a 'misattributed_bullet' finding specifying claimed and actual parent IDs.
//   4. Metric Inflation Guard: Modifying numbers or quantities in reworded bullet claims must generate
//      'unfaithful_rewording' findings identifying the ungrounded metric.
//   5. Technology Token Guard: Introducing ungrounded tech keywords (e.g. Docker, K8s) not present
//      in master bullet text or master skills list must generate 'unfaithful_rewording' findings.
//   6. Summary Node Resolution: Declaring summary citations to non-existent master node IDs must generate
//      'summary_unsupported' findings.
//
// Grounding Constraints:
//   - Zero tolerance for hallucinated metrics, ungrounded skills, or missing node citations.
//   - Discriminates between benign rhetorical rewordings and ungrounded factual additions.
// ============================================================================

// Import node:test testing framework runner module
import { test } from "node:test";

// Import node:assert/strict assertion library module
import assert from "node:assert/strict";

// Import auditor orchestrator function under test
import { auditApplication } from "./audit.ts";

// Import shared contract interfaces for MasterProfile, ResolvedResume, and TailoredProfile
import type { MasterProfile, ResolvedResume, TailoredProfile } from "../contracts/shared-types.ts";

// Constant representing pinned master profile version number for test fixtures
const TEST_VERSION = 1;

// Master profile test fixture containing valid test nodes
const TEST_MASTER: MasterProfile = {
  // Master schema version number
  schema_version: 1,

  // Candidate identity details block
  identity: {
    // Full name of candidate
    full_name: "Teja Mallam",
    // Professional headline string
    headline: "Backend Engineer",
    // Primary email address
    email: "tejamallam00@gmail.com",
    // Optional phone number
    phone: null,
    // Geographic location string
    location: "Hyderabad",
    // External link objects array
    links: [
      // Identity links list (empty)
    ],
  },

  // Master summary node with unique node ID
  summary: {
    // Summary node ID string
    id: "sum-1",
    // Master summary text string
    text: "Backend engineer experienced with Node.js and Express REST APIs.",
  },

  // Education background section entries array
  education: [
    // Education entry 1
    {
      // Education node ID string
      id: "edu-1",
      // Institution name string
      institution: "MLR Institute of Technology",
      // Degree name string
      degree: "B.Tech",
      // Field of study string
      field: "Computer Science",
      // Display start date string
      start_display: "2022",
      // Display end date string
      end_display: "2026",
      // ISO start date
      start_date: null,
      // ISO end date
      end_date: null,
      // Display grade representation string
      grade_display: "8.4 CGPA",
      // Education detail bullets array
      bullets: [
        // Coursework detail bullet node object
        {
          // Bullet ID string
          id: "b-edu-1",
          // Bullet text claim string
          text: "Coursework in data structures and databases",
          // Bullet tags array
          tags: [
            // Coursework tag
            "coursework",
          ],
        },
      ],
    },
  ],

  // Experience background section entries array
  experience: [
    // Experience entry 1
    {
      // Experience node ID string
      id: "exp-1",
      // Company name string
      company: "Event Cell",
      // Job role title string
      role: "Backend Intern",
      // Job location string
      location: "Hyderabad",
      // Display start date string
      start_display: "Jun 2025",
      // Display end date string
      end_display: "Aug 2025",
      // ISO start date
      start_date: null,
      // ISO end date
      end_date: null,
      // Experience detail bullets array
      bullets: [
        // REST API development bullet node object
        {
          // Bullet ID string
          id: "b-exp-1",
          // Bullet text claim string
          text: "Built a REST API with Express and Node.js for a college event portal, handling 500 users",
          // Bullet tags array
          tags: [
            // Node tag
            "node",
            // Express tag
            "express",
            // REST tag
            "rest",
          ],
        },
      ],
    },
  ],

  // Projects section entries array
  projects: [
    // Project entry 1
    {
      // Project node ID string
      id: "proj-1",
      // Project name string
      name: "Portfolio Site",
      // Project external links array
      links: [
        // Project links list (empty)
      ],
      // Display start date string
      start_display: "2025",
      // Display end date string
      end_display: "2025",
      // ISO start date
      start_date: null,
      // ISO end date
      end_date: null,
      // Project detail bullets array
      bullets: [
        // Portfolio site bullet node object
        {
          // Bullet ID string
          id: "b-proj-1",
          // Bullet text claim string
          text: "Built a React portfolio site deployed on Vercel",
          // Bullet tags array
          tags: [
            // React tag
            "react",
          ],
        },
      ],
    },
  ],

  // Skills section entries array
  skills: [
    // Node.js framework skill node object
    {
      // Skill ID string
      id: "s-node",
      // Skill name string
      name: "Node.js",
      // Skill category string
      category: "Frameworks",
    },
    // Express framework skill node object
    {
      // Skill ID string
      id: "s-express",
      // Skill name string
      name: "Express",
      // Skill category string
      category: "Frameworks",
    },
    // React framework skill node object
    {
      // Skill ID string
      id: "s-react",
      // Skill name string
      name: "React",
      // Skill category string
      category: "Frameworks",
    },
  ],

  // Achievements section entries array (empty by default)
  achievements: [
    // Achievements list (empty)
  ],

  // Certifications section entries array (empty by default)
  certifications: [
    // Certifications list (empty)
  ],

  // Identity links array (empty by default)
  links: [
    // Identity links list (empty)
  ],
};

/**
 * Factory helper function to construct a baseline clean ResolvedResume object.
 *
 * Grounding Guarantee:
 * - Every skill reference ('s-node', 's-express') resolves to a master skill node in TEST_MASTER.
 * - Every experience bullet reference ('b-exp-1') resolves to a master bullet under 'exp-1'.
 * - Every project bullet reference ('b-proj-1') resolves to a master bullet under 'proj-1'.
 * - Every education bullet reference ('b-edu-1') resolves to a master bullet under 'edu-1'.
 * - All metrics (500) and technology terms match TEST_MASTER text exactly without hallucinated additions.
 *
 * @returns Clean ResolvedResume object matching TEST_MASTER nodes.
 */
function createCleanResume(): ResolvedResume {
  // Construct clean resolved resume object matching TEST_MASTER
  // Initialize resume payload object
  return {
    // Resume schema version number
    schema_version: 1,

    // Pinned master version number
    master_version: TEST_VERSION,

    // Identity block copied from master
    identity: TEST_MASTER.identity,

    // Section ordering array
    section_order: [
      // Skills section kind string
      "skills",
      // Experience section kind string
      "experience",
      // Projects section kind string
      "projects",
      // Education section kind string
      "education",
    ],

    // Summary text string
    summary: "Backend engineer experienced with Node.js and Express REST APIs.",

    // Valid skills derived from master profile
    skills: [
      // Skill ref for Node.js
      {
        // Skill reference ID
        ref: "s-node",
        // Skill name string
        name: "Node.js",
        // Skill category string
        category: "Frameworks",
      },
      // Skill ref for Express
      {
        // Skill reference ID
        ref: "s-express",
        // Skill name string
        name: "Express",
        // Skill category string
        category: "Frameworks",
      },
    ],

    // Valid experience entries derived from master profile
    experience: [
      // Experience item 1
      {
        // Experience ref matching exp-1
        ref: "exp-1",
        // Company name string
        company: "Event Cell",
        // Role title string
        role: "Backend Intern",
        // Location string
        location: "Hyderabad",
        // Start date string
        start_display: "Jun 2025",
        // End date string
        end_display: "Aug 2025",
        // Bullets array
        bullets: [
          // Bullet item 1
          {
            // Bullet ref matching b-exp-1
            ref: "b-exp-1",
            // Tailored text string
            text: "Built a REST API with Express and Node.js for a college event portal, handling 500 users",
            // Master text string
            master_text: "Built a REST API with Express and Node.js for a college event portal, handling 500 users",
          },
        ],
      },
    ],

    // Valid project entries derived from master profile
    projects: [
      // Project item 1
      {
        // Project ref matching proj-1
        ref: "proj-1",
        // Project name string
        name: "Portfolio Site",
        // Links array
        links: [
          // Links list (empty)
        ],
        // Start date string
        start_display: "2025",
        // End date string
        end_display: "2025",
        // Bullets array
        bullets: [
          // Bullet item 1
          {
            // Bullet ref matching b-proj-1
            ref: "b-proj-1",
            // Tailored text string
            text: "Built a React portfolio site deployed on Vercel",
            // Master text string
            master_text: "Built a React portfolio site deployed on Vercel",
          },
        ],
      },
    ],

    // Valid education entries derived from master profile
    education: [
      // Education item 1
      {
        // Education ref matching edu-1
        ref: "edu-1",
        // Institution name string
        institution: "MLR Institute of Technology",
        // Degree name string
        degree: "B.Tech",
        // Field of study string
        field: "Computer Science",
        // Start date string
        start_display: "2022",
        // End date string
        end_display: "2026",
        // Grade display string
        grade_display: "8.4 CGPA",
        // Bullets array
        bullets: [
          // Bullet item 1
          {
            // Bullet ref matching b-edu-1
            ref: "b-edu-1",
            // Tailored text string
            text: "Coursework in data structures and databases",
            // Master text string
            master_text: "Coursework in data structures and databases",
          },
        ],
      },
    ],

    // Achievements entries array
    achievements: [
      // Achievements list (empty)
    ],

    // Certifications entries array
    certifications: [
      // Certifications list (empty)
    ],
  };
}

/**
 * Factory helper function to construct raw TailoredProfile refs corresponding to clean resume.
 *
 * Grounding Guarantee:
 * - Summary citations ('sum-1', 'b-exp-1') resolve to existing node IDs in TEST_MASTER.
 * - Section ordering matches the standard document layout ('skills', 'experience', 'projects', 'education').
 * - All selected item refs map 1:1 to legitimate master profile nodes without fabricated identifiers.
 *
 * @returns Clean TailoredProfile object matching TEST_MASTER node IDs.
 */
function createCleanTailorRefs(): TailoredProfile {
  // Construct clean raw tailor refs object matching TEST_MASTER
  // Initialize tailor refs payload object
  return {
    // Tailored profile schema version number
    schema_version: 1,

    // Pinned master profile version number
    master_version: TEST_VERSION,

    // Document section order array
    section_order: [
      // Skills section
      "skills",
      // Experience section
      "experience",
      // Projects section
      "projects",
      // Education section
      "education",
    ],

    // Summary block with declared node references array
    summary: {
      // Summary text string
      text: "Backend engineer experienced with Node.js and Express REST APIs.",
      // Supporting master node references array
      refs: [
        // Summary node ID reference
        "sum-1",
        // Bullet node ID reference
        "b-exp-1",
      ],
    },

    // Selected skill references array
    skills: [
      // Skill ref object for Node.js
      {
        // Reference ID
        ref: "s-node",
      },
      // Skill ref object for Express
      {
        // Reference ID
        ref: "s-express",
      },
    ],

    // Selected experience references array
    experience: [
      // Experience ref object 1
      {
        // Experience ref matching exp-1
        ref: "exp-1",
        // Bullets array
        bullets: [
          // Bullet ref object
          {
            // Reference ID
            ref: "b-exp-1",
            // Text claim
            text: "Built a REST API with Express and Node.js for a college event portal, handling 500 users",
          },
        ],
      },
    ],

    // Selected project references array
    projects: [
      // Project ref object 1
      {
        // Project ref matching proj-1
        ref: "proj-1",
        // Bullets array
        bullets: [
          // Bullet ref object
          {
            // Reference ID
            ref: "b-proj-1",
            // Text claim
            text: "Built a React portfolio site deployed on Vercel",
          },
        ],
      },
    ],

    // Selected education references array
    education: [
      // Education ref object 1
      {
        // Education ref matching edu-1
        ref: "edu-1",
        // Bullets array
        bullets: [
          // Bullet ref object
          {
            // Reference ID
            ref: "b-edu-1",
            // Text claim
            text: "Coursework in data structures and databases",
          },
        ],
      },
    ],

    // Selected achievements references array
    achievements: [
      // Achievements list (empty)
    ],

    // Selected certifications references array
    certifications: [
      // Certifications list (empty)
    ],
  };
}

// ============================================================================
// Test Case 1: Clean Grounded Profile Verification
// ============================================================================
// Description: Verify that a fully grounded tailored resume produces status 'audit_clean' and zero findings.
// Test steps:
//   - Step 1: Create a clean ResolvedResume matching TEST_MASTER nodes.
//   - Step 2: Create clean TailoredProfile refs matching TEST_MASTER nodes.
//   - Step 3: Run auditApplication with master, resume, and refs.
//   - Step 4: Verify that outcome is clean, status is 'audit_clean', and findings list is empty.
// ============================================================================
test("auditApplication accepts clean grounded profile", () => {
  // Construct clean resume fixture object from factory
  const resume = createCleanResume();

  // Construct clean tailor refs fixture object from factory
  const refs = createCleanTailorRefs();

  // Audit application using auditor orchestrator function
  const outcome = auditApplication(TEST_MASTER, resume, refs);

  // Assert outcome isClean boolean property is strictly equal to true
  assert.equal(outcome.isClean, true);

  // Assert outcome status string is strictly equal to 'audit_clean'
  assert.equal(outcome.status, "audit_clean");

  // Assert findings array is empty with length strictly equal to 0
  assert.equal(outcome.findings.length, 0);
});

// ============================================================================
// Test Case 2: Unresolved Skill Reference Detection
// ============================================================================
// Description: Verify that a tailored skill ref not present in master profile triggers unresolved_ref finding.
// Verification Logic:
//   - Skill reference "s-fake-docker" is injected into resume skills list.
//   - Auditor checks master.skills map and finds no matching entry for "s-fake-docker".
//   - Auditor flags application as 'audit_flagged' and adds an 'unresolved_ref' finding.
// ============================================================================
test("auditApplication flags unresolved skill reference", () => {
  // Construct clean resume fixture object
  const resume = createCleanResume();

  // Push fake ungrounded skill ref into resume skills array
  resume.skills.push({
    // Fake skill reference ID
    ref: "s-fake-docker",
    // Skill name string
    name: "Docker",
    // Skill category string
    category: "DevOps",
  });

  // Audit application using auditor orchestrator function
  const outcome = auditApplication(TEST_MASTER, resume);

  // Assert outcome isClean boolean is false
  assert.equal(outcome.isClean, false);

  // Assert outcome status is 'audit_flagged'
  assert.equal(outcome.status, "audit_flagged");

  // Check findings for unresolved ref starting with skills path
  const hasUnresolved = outcome.findings.some(
    // Filter predicate function for skills path
    (f) => f.kind === "unresolved_ref" && f.path.startsWith("skills"),
  );

  // Assert unresolved_ref finding exists for skills section
  assert.ok(hasUnresolved);
});

// ============================================================================
// Test Case 3: Unresolved Bullet Reference Detection
// ============================================================================
// Description: Verify that a bullet ref absent from master profile triggers unresolved_ref finding.
// Verification Logic:
//   - Bullet reference "b-fake-k8s" is injected into experience entry bullets.
//   - Auditor checks master bullets index and finds no matching bullet ID.
//   - Auditor flags application as 'audit_flagged' and adds an 'unresolved_ref' finding.
// ============================================================================
test("auditApplication flags unresolved bullet reference", () => {
  // Construct clean resume fixture object
  const resume = createCleanResume();

  // Push fake ungrounded bullet ref into experience entry bullets array
  resume.experience[0]!.bullets.push({
    // Fake bullet reference ID
    ref: "b-fake-k8s",
    // Fake bullet text string
    text: "Deployed services to Kubernetes cluster",
    // Empty master text string
    master_text: "",
  });

  // Audit application using auditor orchestrator function
  const outcome = auditApplication(TEST_MASTER, resume);

  // Assert outcome isClean boolean is false
  assert.equal(outcome.isClean, false);

  // Assert outcome status is 'audit_flagged'
  assert.equal(outcome.status, "audit_flagged");

  // Check findings for unresolved bullet ref containing bullets path
  const hasUnresolvedBullet = outcome.findings.some(
    // Filter predicate function for bullets path
    (f) => f.kind === "unresolved_ref" && f.path.includes("bullets"),
  );

  // Assert unresolved_ref finding exists for bullets section
  assert.ok(hasUnresolvedBullet);
});

// ============================================================================
// Test Case 4: Misattributed Bullet Detection
// ============================================================================
// Description: Verify that rendering a valid bullet under a different parent ID triggers misattributed_bullet.
// Verification Logic:
//   - Project bullet "b-proj-1" (belonging to "proj-1") is reparented under experience entry "exp-1".
//   - Auditor compares expected parent ID against actual parent ID in master profile index.
//   - Auditor flags application as 'audit_flagged' and adds a 'misattributed_bullet' finding.
// ============================================================================
test("auditApplication flags misattributed bullet", () => {
  // Construct clean resume fixture object
  const resume = createCleanResume();

  // Reparent project bullet under experience entry bullets array
  resume.experience[0]!.bullets = [
    // Misattributed bullet entry
    {
      // Bullet reference matching b-proj-1
      ref: "b-proj-1",
      // Bullet text claim string
      text: "Built a React portfolio site deployed on Vercel",
      // Master text string
      master_text: "Built a React portfolio site deployed on Vercel",
    },
  ];

  // Audit application using auditor orchestrator function
  const outcome = auditApplication(TEST_MASTER, resume);

  // Assert outcome isClean boolean is false
  assert.equal(outcome.isClean, false);

  // Assert outcome status is 'audit_flagged'
  assert.equal(outcome.status, "audit_flagged");

  // Find misattributed_bullet finding object from findings array
  const finding = outcome.findings.find(
    // Find predicate function for misattributed_bullet kind
    (f) => f.kind === "misattributed_bullet",
  );

  // Assert finding exists and is truthy
  assert.ok(finding);

  // Verify claimed and actual parent references in finding object
  if (finding && finding.kind === "misattributed_bullet") {
    // Assert bullet ref equals b-proj-1
    assert.equal(finding.ref, "b-proj-1");

    // Assert claimed parent ref equals exp-1
    assert.equal(finding.claimed_parent_ref, "exp-1");

    // Assert actual master parent ref equals proj-1
    assert.equal(finding.actual_parent_ref, "proj-1");
  }
});

// ============================================================================
// Test Case 5: Invented Metric Detection
// ============================================================================
// Description: Verify that inflating numbers in bullet text triggers unfaithful_rewording finding.
// Verification Logic:
//   - Bullet metric "500" is altered to "5000" in bullet text.
//   - Auditor extracts metrics from reworded text and checks against master bullet text.
//   - Auditor flags metric "5000" as ungrounded and adds an 'unfaithful_rewording' finding.
// ============================================================================
test("auditApplication flags invented metric", () => {
  // Construct clean resume fixture object
  const resume = createCleanResume();

  // Inflate metric from 500 to 5000 users in bullet text string
  resume.experience[0]!.bullets[0]!.text = "Built a REST API with Express and Node.js for a college event portal, handling 5000 users";

  // Audit application using auditor orchestrator function
  const outcome = auditApplication(TEST_MASTER, resume);

  // Assert outcome isClean boolean is false
  assert.equal(outcome.isClean, false);

  // Assert outcome status is 'audit_flagged'
  assert.equal(outcome.status, "audit_flagged");

  // Check findings for invented metric reason string
  const hasMetricFinding = outcome.findings.some(
    // Filter predicate function for metric reason
    (f) => f.kind === "unfaithful_rewording" && f.reason.includes("metric"),
  );

  // Assert unfaithful_rewording finding exists for metric inflation
  assert.ok(hasMetricFinding);
});

// ============================================================================
// Test Case 6: Ungrounded Technology Token Detection
// ============================================================================
// Description: Verify that introducing ungrounded technology tokens triggers unfaithful_rewording finding.
// Verification Logic:
//   - Term "Docker" is inserted into bullet text when "Docker" is not in master bullet or master skills.
//   - Auditor checks tokens against allowable rhetorical words and master profile tokens.
//   - Auditor flags "docker" as ungrounded technology token and adds an 'unfaithful_rewording' finding.
// ============================================================================
test("auditApplication flags ungrounded technology token", () => {
  // Construct clean resume fixture object
  const resume = createCleanResume();

  // Smuggle ungrounded Docker technology token into bullet text string
  resume.experience[0]!.bullets[0]!.text = "Built a REST API with Express, Node.js and Docker for a college event portal, handling 500 users";

  // Audit application using auditor orchestrator function
  const outcome = auditApplication(TEST_MASTER, resume);

  // Assert outcome isClean boolean is false
  assert.equal(outcome.isClean, false);

  // Assert outcome status is 'audit_flagged'
  assert.equal(outcome.status, "audit_flagged");

  // Check findings for ungrounded docker token in reason
  const hasDockerFinding = outcome.findings.some(
    // Filter predicate function for docker term
    (f) => f.kind === "unfaithful_rewording" && f.reason.includes("docker"),
  );

  // Assert unfaithful_rewording finding exists naming docker
  assert.ok(hasDockerFinding);
});

// ============================================================================
// Test Case 7: Summary Reference to Missing Node ID Detection
// ============================================================================
// Description: Verify that summary declaring non-existent node ID references triggers summary_unsupported finding.
// Verification Logic:
//   - Non-existent node ID "nonexistent-node-id" is added to summary.refs in TailoredProfile.
//   - Auditor checks summary refs against master index node IDs.
//   - Auditor flags summary reference as ungrounded and adds a 'summary_unsupported' finding.
// ============================================================================
test("auditApplication flags summary referencing missing node ID", () => {
  // Construct clean resume fixture object
  const resume = createCleanResume();

  // Construct clean tailor refs fixture object
  const refs = createCleanTailorRefs();

  // Inject fake non-existent node ID into summary refs array
  refs.summary!.refs = [
    // Fake node reference ID
    "nonexistent-node-id",
  ];

  // Audit application with bad summary ref declaration
  const outcome = auditApplication(TEST_MASTER, resume, refs);

  // Assert outcome isClean boolean is false
  assert.equal(outcome.isClean, false);

  // Assert outcome status is 'audit_flagged'
  assert.equal(outcome.status, "audit_flagged");

  // Check findings for summary_unsupported kind
  const hasSummaryFinding = outcome.findings.some(
    // Filter predicate function for summary_unsupported
    (f) => f.kind === "summary_unsupported",
  );

  // Assert summary_unsupported finding exists in findings
  assert.ok(hasSummaryFinding);
});

// --- bulletGroundingGaps: rule 5 in its one shared definition (2026-10-31) -----------------
// The auditor and the review page's AI box both call this, so a verb swap the master never
// used is flagged the same way in both places.
test("bulletGroundingGaps flags a word and a number the master bullet does not supply", async () => {
  // Imported here so this block stays self-contained in an existing suite.
  const { bulletGroundingGaps } = await import("./detector.ts");
  // "Cut" -> "Reduced" is honest, but "reduced" is in neither the master text nor the allowlist.
  const gaps = bulletGroundingGaps("Reduced p95 latency by 40% using Kafka", "Cut p95 latency by 30%", new Set(["kafka"]));
  // 40 is new; 95 is in the master text ("p95" splits to "p" and "95"), so only 40 is flagged.
  assert.deepEqual(gaps.metrics, ["40"]);
  // "using" is allowlisted and "kafka" is a master skill token, so only "reduced" is flagged.
  assert.deepEqual(gaps.terms, ["reduced"]);
});

test("bulletGroundingGaps passes a rewording that stays inside the master and the allowlist", async () => {
  // Same import as above.
  const { bulletGroundingGaps } = await import("./detector.ts");
  // Every word comes from the master bullet or the allowlist ("built", "using").
  const gaps = bulletGroundingGaps("Built billing API using Postgres", "billing API on Postgres", new Set());
  // Grounded: nothing to flag.
  assert.deepEqual(gaps, { metrics: [], terms: [] });
});

// --- Ground truth is the pinned master, never the resume under audit (2026-11-04) ------------
// `master_text` rides inside the tailored profile for the §15 diff view. The detector used to
// prefer it over the master's own bullet, so a profile whose copy agreed with its fabrication
// audited clean (probe on live rows, 2026-11-04: inflated metric + matching master_text -> 0 findings).
test("detectAuditFindings ignores a master_text carried in the resume", () => {
  // Construct clean resume fixture object
  const resume = createCleanResume();
  // The same inflation the "flags invented metric" test catches: 500 users becomes 5000.
  const inflated = "Built a REST API with Express and Node.js for a college event portal, handling 5000 users";
  // The claim itself.
  resume.experience[0]!.bullets[0]!.text = inflated;
  // And the carried copy made to agree with it: the only thing that changed vs that test.
  resume.experience[0]!.bullets[0]!.master_text = inflated;
  // Audited against the master profile, which still says 500.
  const outcome = auditApplication(TEST_MASTER, resume);
  // The carried copy must not launder the claim.
  assert.equal(outcome.status, "audit_flagged");
  // Named for the metric, as the master is what it was compared against.
  assert.ok(outcome.findings.some((f) => f.kind === "unfaithful_rewording" && f.reason.includes("5000")), JSON.stringify(outcome.findings));
});
