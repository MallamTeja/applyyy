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

// ============================================================================
// jd_keyword_dropped (P2 #17, Teja ruling A, 2026-11-07 09:47 IST)
// ============================================================================
// The tailor prompt's keep rule (630d6b5) is only a hint: live row 67b979b3 lost its ONLY keyword
// match when the model turned "AI orchestration pipelines" into "orchestration pipelines". These
// tests pin the hard guard: a posting keyword the pinned master bullet contains, missing from the
// tailored bullet, is a finding, so the row is flagged for individual review.

// A master whose experience bullet names Kafka, so a posting asking for Kafka makes it a kept keyword.
function masterWithBulletText(text: string): MasterProfile {
  // A deep copy, so no other test sees the edited bullet.
  const master = structuredClone(TEST_MASTER) as { experience: { bullets: { text: string }[] }[] } & MasterProfile;
  // The one experience bullet the clean resume renders (b-exp-1).
  master.experience[0].bullets[0].text = text;
  // Typed back as the contract shape.
  return master;
}

// THE RED-ON-REVERT TEST: remove the jd_keyword_dropped check in detector.ts and this goes red.
test("jd_keyword_dropped: a posting keyword the master bullet had and the tailored bullet dropped is one finding", () => {
  // The master says Kafka; the clean resume's bullet text does not.
  const master = masterWithBulletText("Built a REST API with Express and Node.js on Kafka for a college event portal, handling 500 users");
  // A posting that asks for Kafka.
  const outcome = auditApplication(master, createCleanResume(), null, "We stream events through Kafka.");
  // Exactly one finding, of the new kind, naming the keyword and the bullet it was dropped from.
  assert.deepEqual(outcome.findings.map((f) => [f.kind, f.path]), [["jd_keyword_dropped", "experience[0].bullets[0]"]]);
  // The reason names the dropped keyword, so the reviewer knows what to put back.
  assert.ok(outcome.findings[0].reason.includes("Kafka"), outcome.findings[0].reason);
  // And the same word as data (peer 3, 2026-11-07), so the review page never parses the prose.
  const finding = outcome.findings[0];
  // Narrowed by kind, so `keywords` is the typed field, not a cast.
  assert.deepEqual(finding.kind === "jd_keyword_dropped" ? finding.keywords : null, ["Kafka"]);
  // Ruling A: the row goes to individual review.
  assert.equal(outcome.status, "audit_flagged");
});

// Control: the posting never names Kafka, so dropping it is the tailor's right.
test("jd_keyword_dropped control: a keyword the posting does not name may be dropped", () => {
  // The same master and resume.
  const master = masterWithBulletText("Built a REST API with Express and Node.js on Kafka for a college event portal, handling 500 users");
  // A posting about Node.js and Express only; both are still in the tailored bullet.
  const outcome = auditApplication(master, createCleanResume(), null, "Node.js and Express backend.");
  // Clean.
  assert.deepEqual(outcome.findings, []);
});

// Control: "C" in the master is not the "C++" a posting asks for (the LETTER_LANGUAGES rule, fa5c31d).
test("jd_keyword_dropped control: a master C and a C++ posting give no finding", () => {
  // The master mentions C; the tailored bullet does not.
  const master = masterWithBulletText("Built a REST API with Express and Node.js in C for a college event portal, handling 500 users");
  // The posting names only C++.
  const outcome = auditApplication(master, createCleanResume(), null, "Systems work in C++.");
  // Nothing dropped: the master never said C++.
  assert.deepEqual(outcome.findings, []);
});

// Control: an audit with no posting (every caller before 2026-11-07) runs the old checks only.
test("jd_keyword_dropped control: with no job description the check does not run", () => {
  // Kafka dropped, but no posting to say it mattered.
  const master = masterWithBulletText("Built a REST API with Express and Node.js on Kafka for a college event portal, handling 500 users");
  // The three-argument call every older caller makes.
  const outcome = auditApplication(master, createCleanResume(), null);
  // Clean, as before.
  assert.deepEqual(outcome.findings, []);
});

// ============================================================================
// Summary variants (pending #11, 2026-11-07)
// ============================================================================
// A tailoring that picks an owner-written variant cites that variant's summary id. The auditor (edge AND the
// web's approve re-check) must accept it, or every variant row is flagged and the review page marks the whole
// summary as fabricated (peer 3's finding: detector.ts knew only master.summary.id). Red on revert.
test("summary variant: the picked variant's summary id is a supported summary ref", () => {
  // The master plus one variant whose summary has its own id.
  const master = { ...TEST_MASTER, summary_variants: [{ id: "variant-swe", label: "Software engineering", headline: "Software Engineer", summary: { id: "summary-swe", text: "Software engineer who ships Node.js services." } }] } as MasterProfile;
  // The clean refs, picking the variant and citing its summary plus a real bullet.
  const refs = { ...createCleanTailorRefs(), summary_variant: "variant-swe", summary: { text: "Software engineer who ships Node.js services.", refs: ["summary-swe", "b-exp-1"] } } as TailoredProfile;
  // Audited.
  const outcome = auditApplication(master, createCleanResume(), refs);
  // No summary finding: the variant's paragraph is the owner's own text.
  assert.deepEqual(outcome.findings, []);
});

// Control: a variant that is NOT picked is not citable, matching the validator's rule.
test("summary variant control: an unpicked variant's summary id is still unsupported", () => {
  // The same master.
  const master = { ...TEST_MASTER, summary_variants: [{ id: "variant-swe", label: "Software engineering", headline: "Software Engineer", summary: { id: "summary-swe", text: "Software engineer who ships Node.js services." } }] } as MasterProfile;
  // Cites the variant summary without picking it.
  const refs = { ...createCleanTailorRefs(), summary: { text: "Software engineer.", refs: ["summary-swe"] } } as TailoredProfile;
  // Audited.
  const outcome = auditApplication(master, createCleanResume(), refs);
  // Flagged as an unsupported summary.
  assert.deepEqual(outcome.findings.map((f) => f.kind), ["summary_unsupported"]);
});

// ============================================================================
// Summary numbers (Teja ruling D4, 2026-11-07 10:38 IST)
// ============================================================================
// "Every number in the resume SUMMARY must appear in a node the summary cites; a miss gives a finding, and the
// row goes to individual review." Refs alone only prove the cited ids EXIST; these pin that the printed numbers
// come from them too.

// THE RED-ON-REVERT TEST: remove the summary-number check in detector.ts and this goes red.
test("summary numbers: a number no cited node states is one summary_unsupported finding", () => {
  // The clean resume, whose summary now claims an audience size the master never states.
  const resume = { ...createCleanResume(), summary: "Backend engineer who served 40 engineers with Node.js and Express REST APIs." };
  // The clean refs: sum-1 and b-exp-1 exist, so only the number can be wrong.
  const outcome = auditApplication(TEST_MASTER, resume, createCleanTailorRefs());
  // Exactly one finding, on the summary.
  assert.deepEqual(outcome.findings.map((f) => [f.kind, f.path]), [["summary_unsupported", "summary"]]);
  // It names the unsupported number, so the reviewer knows what to check.
  assert.ok(outcome.findings[0].reason.includes("40"), outcome.findings[0].reason);
  // The ruling: the row goes to individual review.
  assert.equal(outcome.status, "audit_flagged");
});

// Control: a number a cited bullet states is grounded (b-exp-1 says "500 users").
test("summary numbers control: a number in a cited bullet gives no finding", () => {
  // The summary repeats the cited bullet's 500.
  const resume = { ...createCleanResume(), summary: "Backend engineer who built a Node.js REST API serving 500 users." };
  // Same clean refs, which cite b-exp-1.
  const outcome = auditApplication(TEST_MASTER, resume, createCleanTailorRefs());
  // Clean: the check ran (the test above proves it can fire) and found the number.
  assert.deepEqual(outcome.findings, []);
});

// Control: the number exists in the master, but only in a node the summary does NOT cite.
test("summary numbers control: a number only in an uncited node is still a finding", () => {
  // The same 500-user summary as the control above.
  const resume = { ...createCleanResume(), summary: "Backend engineer who built a Node.js REST API serving 500 users." };
  // Cites only the master summary, which states no number; b-exp-1 is no longer cited.
  const refs = { ...createCleanTailorRefs(), summary: { text: resume.summary, refs: ["sum-1"] } } as TailoredProfile;
  // Audited.
  const outcome = auditApplication(TEST_MASTER, resume, refs);
  // Flagged on the summary, naming 500: being SOMEWHERE in the master is not enough.
  assert.deepEqual(outcome.findings.map((f) => [f.kind, f.reason.includes("500")]), [["summary_unsupported", true]]);
});

// Control: a resume with no summary has nothing to check.
test("summary numbers control: no summary gives no finding", () => {
  // The clean resume with the summary removed.
  const resume = { ...createCleanResume(), summary: null };
  // Audited with the clean refs.
  const outcome = auditApplication(TEST_MASTER, resume, createCleanTailorRefs());
  // Clean.
  assert.deepEqual(outcome.findings, []);
});

// ============================================================================
// ref_path (2026-11-07, peer 3 via the orchestrator)
// ============================================================================
// The review page keys a bullet line by refs ("experience.<entry-ref>.<bullet-ref>", diffAdapter.ts:412),
// while `path` is positional ("experience[0].bullets[0]"). Every finding now also carries ref_path in the
// page's form: additive, so `path` is unchanged. Red on revert.
test("ref_path: a bullet finding carries the review page's ref form beside the positional path", () => {
  // An invented metric in the experience bullet, which the detector flags.
  const resume = createCleanResume();
  // Mutated in place: the fixture factory returns a fresh object.
  (resume.experience[0].bullets[0] as { text: string }).text = "Built a REST API with Express and Node.js for a college event portal, handling 98765 users";
  // Audited.
  const outcome = auditApplication(TEST_MASTER, resume);
  // One finding, on that bullet.
  const finding = outcome.findings[0];
  // The positional path is unchanged.
  assert.equal(finding?.path, "experience[0].bullets[0]");
  // And the ref path names the entry and bullet by id.
  assert.equal(finding?.ref_path, "experience.exp-1.b-exp-1");
});

// The summary keeps the one key the page already uses for it.
test("ref_path: a summary finding's ref_path is 'summary'", () => {
  // Zero summary refs, which the detector flags.
  const refs = { ...createCleanTailorRefs(), summary: { text: "Backend engineer.", refs: [] } } as TailoredProfile;
  // Audited.
  const outcome = auditApplication(TEST_MASTER, createCleanResume(), refs);
  // Every finding here is on the summary, keyed the page's way.
  assert.deepEqual(outcome.findings.map((f) => f.ref_path), ["summary"]);
});

// ============================================================================
// Skill tied to its entry (Teja ruling 2026-11-07 ~22:10 IST: "flag it for review")
// ============================================================================
// The validator lets any master skill appear in any bullet (skillTokens), so "built X using AWS" passed
// even where that project never used AWS. The master has no per-entry skills field; an entry's tie is the
// text of its own master bullets (live master v24 measured: 0 of 12 rows flag, 329 terms checked).

// The clean resume with its one experience bullet rewritten.
function resumeWithExperienceBullet(text: string): ResolvedResume {
  // A deep copy, so no other test sees the rewrite.
  const resume = structuredClone(createCleanResume()) as { experience: { bullets: { text: string }[] }[] } & ResolvedResume;
  // b-exp-1, rendered at experience[0].bullets[0].
  resume.experience[0].bullets[0].text = text;
  // Typed back.
  return resume;
}
// The findings this check produces, told apart from other unfaithful_rewording findings by their own words.
const untiedFindings = (findings: readonly { kind: string; reason: string }[]) => findings.filter((f) => f.reason.includes("never ties to"));

// THE RED-ON-REVERT TEST: remove the entry-tie check in detector.ts and this goes red.
test("skill tie: a master skill in a bullet whose entry never mentions it is a finding naming the skill and the entry", () => {
  // React is a master skill, but only the Portfolio Site project mentions it; the Event Cell job does not.
  const outcome = auditApplication(TEST_MASTER, resumeWithExperienceBullet("Built a REST API with Express and Node.js using React for a college event portal, handling 500 users"), null);
  // Exactly one such finding, on the bullet.
  assert.deepEqual(untiedFindings(outcome.findings).map((f) => [f.kind, (f as { path: string }).path]), [["unfaithful_rewording", "experience[0].bullets[0]"]]);
  // It names the skill and the entry, so Teja knows what to remove or confirm.
  assert.match(untiedFindings(outcome.findings)[0].reason, /never ties to Event Cell - Backend Intern: React\./);
  // The row goes to individual review.
  assert.equal(outcome.status, "audit_flagged");
});

// Control: the same skill in the entry that does mention it passes (the clean project bullet names React).
test("skill tie control: React in the Portfolio Site project, whose master bullet names React, is clean", () => {
  // The untouched clean resume: the project bullet says React and its master bullet does too.
  const outcome = auditApplication(TEST_MASTER, createCleanResume(), null);
  // No finding at all.
  assert.deepEqual(outcome.findings, []);
});

// Punctuation: "NodeJS" in the tailored bullet is the same term as the master's "Node.js".
test("skill tie control: NodeJS and Node.js are one term, so a respelling is not an untied skill", () => {
  // The master bullet says "Node.js"; the tailored bullet respells it.
  const outcome = auditApplication(TEST_MASTER, resumeWithExperienceBullet("Built a REST API with Express and NodeJS for a college event portal, handling 500 users"), null);
  // Not reported as untied (another rule may still question the spelling; that is not this check).
  assert.deepEqual(untiedFindings(outcome.findings), []);
});

// Punctuation: C++ is matched as a whole term, and a master "C" never ties a "C++".
test("skill tie: C++ in a bullet whose entry says only C is untied; the same entry saying C++ is tied", () => {
  // A master whose job bullet says C, with C++ as a master skill.
  const withC = masterWithBulletText("Built a REST API with Express and Node.js in C for a college event portal, handling 500 users");
  // C++ added as a master skill, so it is a skill the validator would let into any bullet.
  const master = { ...withC, skills: [...withC.skills, { id: "s-cpp", name: "C++", category: "Languages" }] } as MasterProfile;
  // The tailored bullet claims C++.
  const claimsCpp = resumeWithExperienceBullet("Built a REST API with Express and Node.js in C++ for a college event portal, handling 500 users");
  // Flagged, naming C++.
  assert.match(untiedFindings(auditApplication(master, claimsCpp, null).findings)[0]?.reason ?? "", /: C\+\+\./);
  // Positive control: when the entry's master bullet says C++, the same bullet is tied.
  const withCpp = { ...masterWithBulletText("Built a REST API with Express and Node.js in C++ for a college event portal, handling 500 users"), skills: master.skills } as MasterProfile;
  // No untied finding.
  assert.deepEqual(untiedFindings(auditApplication(withCpp, claimsCpp, null).findings), []);
});

// ============================================================================
// Summary words (pending P1 #7a, 2026-11-07)
// ============================================================================
// D4 checks the summary's numbers only. Its skill and technology words must also exist in the master.

// The clean resume with a different printed summary.
const resumeWithSummary = (summary: string): ResolvedResume => ({ ...createCleanResume(), summary });
// This check's findings, told apart from D4's by their own words.
const unknownSummaryFindings = (findings: readonly { kind: string; reason: string }[]) => findings.filter((f) => f.reason.includes("never mentions"));

// THE RED-ON-REVERT TEST: remove the summary-words check in detector.ts and this goes red.
test("summary words: a technology the master never mentions is a summary_unsupported finding naming it", () => {
  // Kubernetes is in no skill, bullet or summary of the master.
  const outcome = auditApplication(TEST_MASTER, resumeWithSummary("Backend engineer experienced with Node.js, Express and Kubernetes."), createCleanTailorRefs());
  // One finding on the summary, of the summary's kind.
  assert.deepEqual(unknownSummaryFindings(outcome.findings).map((f) => [f.kind, (f as { path: string }).path]), [["summary_unsupported", "summary"]]);
  // Naming Kubernetes, and not the words the master does state.
  assert.match(unknownSummaryFindings(outcome.findings)[0].reason, /never mentions: Kubernetes$/);
  // The row goes to individual review.
  assert.equal(outcome.status, "audit_flagged");
});

// Fail closed: with no tailor refs, D4 is skipped, but this check still runs.
test("summary words: with no tailor refs the check still runs (fails closed, never skipped)", () => {
  // The three-argument call with null refs.
  const outcome = auditApplication(TEST_MASTER, resumeWithSummary("Backend engineer experienced with Node.js and Kubernetes."), null);
  // Still flagged.
  assert.equal(unknownSummaryFindings(outcome.findings).length, 1);
});

// Variants: a word in the PICKED variant's paragraph passes; the same word in an unpicked variant does not.
test("summary words: the picked variant's own paragraph vouches for its words; an unpicked one does not", () => {
  // A master with one variant that mentions Kubernetes.
  const master = { ...TEST_MASTER, summary_variants: [{ id: "variant-ops", label: "Ops", headline: "Platform Engineer", summary: { id: "summary-ops", text: "Platform engineer running Kubernetes clusters." } }] } as MasterProfile;
  // The summary the tailor printed.
  const resume = resumeWithSummary("Platform engineer running Kubernetes clusters.");
  // Picked: the variant's words are the owner's own.
  const picked = { ...createCleanTailorRefs(), summary_variant: "variant-ops", summary: { text: "Platform engineer running Kubernetes clusters.", refs: ["summary-ops"] } } as TailoredProfile;
  // No unknown-word finding.
  assert.deepEqual(unknownSummaryFindings(auditApplication(master, resume, picked).findings), []);
  // Not picked: Kubernetes is unknown again.
  assert.equal(unknownSummaryFindings(auditApplication(master, resume, createCleanTailorRefs()).findings).length, 1);
});

// Control: the clean summary names only words the master has, including the punctuated Node.js.
test("summary words control: Node.js and Express, both in the master, give no finding", () => {
  // The clean resume's own summary.
  const outcome = auditApplication(TEST_MASTER, createCleanResume(), createCleanTailorRefs());
  // Clean.
  assert.deepEqual(outcome.findings, []);
});
