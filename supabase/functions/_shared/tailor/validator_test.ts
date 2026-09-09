// THE MOST IMPORTANT TEST IN THE REPO (PROJECT_PLAN.md §19). It is the
// load-bearing wall under constraint #2 — "never invent experience, projects,
// skills, technologies, metrics, companies, certifications, education or
// qualifications" — and under §10 defense 1, which says the dishonest output
// should be structurally impossible rather than merely detected.
//
// The worked example in §11 is used verbatim as the fixture, so these tests fail
// the day the implementation stops agreeing with the plan's own example.
import { test } from "node:test";
// Strict assertions: a validator that type-coerces is a validator that lets a
// truthy-but-wrong value through.
import assert from "node:assert/strict";
// Explicit .ts extension — required by Deno, accepted by Node (04's spike).
import { validateTailorProposal } from "./validator.ts";
// Placeholder types until applyyy-aa ships packages/shared-types.
import type { MasterProfile } from "../contracts/pending-shared-types.ts";

// The master profile from §11, transcribed exactly. Every honesty decision below
// is measured against this and nothing else.
const MASTER: MasterProfile = {
  // Version is carried into the tailored artifact so §9 resume pinning works.
  version: 1,
  bullets: [
    {
      // Stable id; the Tailor references this instead of retyping the sentence.
      id: "bullet-rest-api",
      // Verbatim from §11.
      text: "Built a REST API with Express and Node.js for a college event portal, handling 500 users",
    },
    {
      // A second bullet so "selects a subset" is a real behaviour, not a no-op.
      id: "bullet-college-portal-ui",
      // Unrelated content, used to prove selection actually drops things.
      text: "Built the React front end for the same college event portal",
    },
  ],
  skills: [
    // The §11 skills line, one row per skill so each can be referenced by id.
    { id: "skill-javascript", name: "JavaScript" },
    { id: "skill-react", name: "React" },
    { id: "skill-node", name: "Node.js" },
    { id: "skill-express", name: "Express" },
    { id: "skill-mongodb", name: "MongoDB" },
    { id: "skill-git", name: "Git" },
    { id: "skill-python", name: "Python" },
  ],
};

// §11's SAFE edit: same project, same 500 users, same tech, reworded to match the
// JD's language. If a recruiter asks, Teja can talk for ten minutes. This must pass
// — a validator that rejects it is useless, because then nothing tailors at all.
test("accepts the safe rewrite from the plan's own worked example", () => {
  // Exactly the tailored bullet printed in §11.
  const result = validateTailorProposal(
    {
      bullets: [
        {
          // A real id from the master.
          masterBulletId: "bullet-rest-api",
          // Reworded, but every fact traces back to the master bullet.
          reworded: "Designed and shipped a production REST API in Node.js/Express serving 500+ users for a college event platform",
        },
      ],
      // Skills are SELECTED by id; the model supplies no skill text at all.
      skillIds: ["skill-node", "skill-express", "skill-javascript", "skill-react", "skill-mongodb", "skill-git", "skill-python"],
    },
    MASTER,
  );
  // The whole tailoring feature depends on this being accepted.
  assert.equal(result.ok, true);
});

// §11's FABRICATED edit, attempted the only way the type system still permits:
// by referencing a skill id that does not exist. "Docker" and "PostgreSQL" are not
// on the master, so there is no id to name.
test("rejects a skill id that does not exist in the master", () => {
  // The model tries to add Docker because the JD asked for it.
  const result = validateTailorProposal(
    {
      bullets: [{ masterBulletId: "bullet-rest-api", reworded: "Built a REST API with Express and Node.js for a college event portal, handling 500 users" }],
      // "skill-docker" was never in the master profile.
      skillIds: ["skill-node", "skill-docker"],
    },
    MASTER,
  );
  // Rejected outright — this never reaches the Auditor.
  assert.equal(result.ok, false);
  // The dashboard has to be able to say WHICH id was invented.
  assert.ok(
    result.ok === false && result.violations.some((v) => v.kind === "unknown_skill_id" && v.id === "skill-docker"),
    "expected an unknown_skill_id violation naming skill-docker",
  );
});

// The same attack aimed at experience rather than skills.
test("rejects a bullet id that does not exist in the master", () => {
  // An entire achievement the model made up.
  const result = validateTailorProposal(
    {
      bullets: [{ masterBulletId: "bullet-kubernetes-migration", reworded: "Led the migration of 40 services to Kubernetes" }],
      // Skills are fine; the fabrication is in the experience.
      skillIds: ["skill-node"],
    },
    MASTER,
  );
  // Invented experience is constraint #2's first named category.
  assert.equal(result.ok, false);
  // Named precisely so the failure is debuggable from the dashboard.
  assert.ok(
    result.ok === false && result.violations.some((v) => v.kind === "unknown_bullet_id" && v.id === "bullet-kubernetes-migration"),
    "expected an unknown_bullet_id violation",
  );
});

// THE GAP THAT ID-CHECKING ALONE LEAVES OPEN. The reference is perfectly valid,
// but the reworded string smuggles in a technology the master does not contain.
// Checking ids and stopping there would wave this straight through.
test("rejects a valid bullet id whose rewording smuggles in an unbacked technology", () => {
  // Real id, real project — plus one word that was never true.
  const result = validateTailorProposal(
    {
      bullets: [
        {
          // Legitimate reference.
          masterBulletId: "bullet-rest-api",
          // "Docker" appears nowhere in the master bullet or the master skills.
          reworded: "Built a REST API with Express, Node.js and Docker for a college event portal, handling 500 users",
        },
      ],
      // The skills list is honest; the lie is inside the bullet text.
      skillIds: ["skill-node"],
    },
    MASTER,
  );
  // This is the case that makes the validator more than an id lookup.
  assert.equal(result.ok, false);
  // The offending word is reported so a human can judge it.
  assert.ok(
    result.ok === false && result.violations.some((v) => v.kind === "unverifiable_token" && v.token === "docker"),
    "expected an unverifiable_token violation naming docker",
  );
});

// Metrics are named explicitly in constraint #2, and inflating one is the easiest
// lie for a language model to tell while sounding entirely plausible.
test("rejects an inflated metric that does not appear in the master bullet", () => {
  // 500 users quietly becomes 5000.
  const result = validateTailorProposal(
    {
      bullets: [
        {
          // Real bullet.
          masterBulletId: "bullet-rest-api",
          // The only change is the number.
          reworded: "Built a REST API with Express and Node.js for a college event portal, handling 5000 users",
        },
      ],
      // Irrelevant to this case.
      skillIds: ["skill-node"],
    },
    MASTER,
  );
  // An invented metric is a fabrication even when every word around it is true.
  assert.equal(result.ok, false);
  // Reported with the value, because "which number" is the first thing a reviewer asks.
  assert.ok(
    result.ok === false && result.violations.some((v) => v.kind === "invented_metric" && v.value === "5000"),
    "expected an invented_metric violation naming 5000",
  );
});

// "500+" is the §11 example's own phrasing and must not be mistaken for a new number.
test("accepts a metric that is only reformatted, not changed", () => {
  // 500 users written as 500+ users is the same claim.
  const result = validateTailorProposal(
    {
      bullets: [{ masterBulletId: "bullet-rest-api", reworded: "Built a REST API in Node.js and Express for a college event portal serving 500+ users" }],
      // Not under test here.
      skillIds: ["skill-node"],
    },
    MASTER,
  );
  // A false positive here would block the plan's own approved rewrite.
  assert.equal(result.ok, true);
});

// Referencing the same master item twice pads the resume with duplicated evidence
// and is malformed output regardless of intent.
test("rejects a duplicated bullet reference", () => {
  // The same achievement claimed as two separate achievements.
  const result = validateTailorProposal(
    {
      bullets: [
        { masterBulletId: "bullet-rest-api", reworded: "Built a REST API with Express and Node.js for a college event portal, handling 500 users" },
        { masterBulletId: "bullet-rest-api", reworded: "Built a REST API with Node.js for a college event portal, handling 500 users" },
      ],
      // Not under test here.
      skillIds: ["skill-node"],
    },
    MASTER,
  );
  // One master item, one line on the resume.
  assert.equal(result.ok, false);
  // Named so the Tailor prompt can be corrected rather than guessed at.
  assert.ok(
    result.ok === false && result.violations.some((v) => v.kind === "duplicate_bullet_id"),
    "expected a duplicate_bullet_id violation",
  );
});

// A duplicated skill is the same malformed-output problem on the skills line.
test("rejects a duplicated skill reference", () => {
  // The same skill selected twice.
  const result = validateTailorProposal(
    {
      bullets: [{ masterBulletId: "bullet-rest-api", reworded: "Built a REST API with Express and Node.js for a college event portal, handling 500 users" }],
      // "skill-node" appears twice.
      skillIds: ["skill-node", "skill-node"],
    },
    MASTER,
  );
  // Rejected rather than silently de-duplicated, because silent repair hides a
  // misbehaving prompt.
  assert.equal(result.ok, false);
  // Named for the same reason.
  assert.ok(
    result.ok === false && result.violations.some((v) => v.kind === "duplicate_skill_id"),
    "expected a duplicate_skill_id violation",
  );
});

// A resume with no experience on it is not a tailoring result, it is a failure
// that would otherwise sail through as "no violations found".
test("rejects a proposal that selects no bullets at all", () => {
  // Empty selection.
  const result = validateTailorProposal({ bullets: [], skillIds: ["skill-node"] }, MASTER);
  // Must be a violation, not a vacuous pass.
  assert.equal(result.ok, false);
  // Named distinctly from the fabrication cases, since the remedy is different.
  assert.ok(
    result.ok === false && result.violations.some((v) => v.kind === "empty_selection"),
    "expected an empty_selection violation",
  );
});

// STRUCTURAL GUARANTEE. Even on a fully valid proposal, the skill text on the
// output comes from the MASTER, never from the model — so there is no code path,
// valid or invalid, by which a model-authored skill string reaches the PDF.
test("renders skill names from the master, never from model-supplied text", () => {
  // A valid proposal referencing one skill.
  const result = validateTailorProposal(
    {
      bullets: [{ masterBulletId: "bullet-rest-api", reworded: "Built a REST API with Express and Node.js for a college event portal, handling 500 users" }],
      // MongoDB is what the master actually says.
      skillIds: ["skill-mongodb"],
    },
    MASTER,
  );
  // Sanity: the proposal is valid.
  assert.equal(result.ok, true);
  // The rendered name is the master's canonical spelling.
  assert.deepEqual(
    result.ok === true ? result.resume.skills : null,
    [{ masterSkillId: "skill-mongodb", name: "MongoDB" }],
  );
});

// The tailored artifact must record which master version it came from, or §9's
// resume pinning and the Auditor's verdict both lose their meaning.
test("stamps the tailored resume with the master version it derived from", () => {
  // Any valid proposal.
  const result = validateTailorProposal(
    {
      bullets: [{ masterBulletId: "bullet-rest-api", reworded: "Built a REST API with Express and Node.js for a college event portal, handling 500 users" }],
      // Not under test here.
      skillIds: ["skill-node"],
    },
    MASTER,
  );
  // The version travels with the artifact.
  assert.equal(result.ok === true ? result.resume.masterVersion : null, MASTER.version);
});

// Every violation must be reported in one pass. Returning only the first would
// make fixing a bad prompt an iterative guessing game.
test("reports every violation in a single pass rather than stopping at the first", () => {
  // Two independent fabrications plus a duplicate.
  const result = validateTailorProposal(
    {
      bullets: [{ masterBulletId: "bullet-nope", reworded: "Led a team of five engineers" }],
      // Two invented skills.
      skillIds: ["skill-docker", "skill-kubernetes"],
    },
    MASTER,
  );
  // Rejected, obviously.
  assert.equal(result.ok, false);
  // All three problems surfaced together.
  assert.equal(result.ok === false ? result.violations.length : 0, 3);
});
