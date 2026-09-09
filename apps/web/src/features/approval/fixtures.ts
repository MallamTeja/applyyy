/* Fixtures for the diff view, transcribed from PROJECT_PLAN.md section 11.
 *
 * Section 11 is a fully worked example: real master text, real Tailor output,
 * and an explicit verdict table naming PostgreSQL and Docker as the two
 * untraceable claims. Building the flagship screen against the spec's own
 * example means the screen can be judged correct before any agent exists to
 * produce real rows - and when the Auditor does land, this fixture becomes the
 * regression test for the renderer.
 *
 * Two fixtures, because the product has two review paths and a screen that
 * only ever demonstrates the dangerous one teaches the wrong lesson:
 *   - zomatoBackendIntern: Bucket B. Contains fabrication. Individual review.
 *   - swiggyFrontendIntern: Bucket A. Fully traced. Batch-approvable.
 */

import type { ResumeDiff } from './diffModel';

/* THE section 11 CASE.
 *
 * Job: Backend Intern at Zomato - "Node.js, REST APIs, PostgreSQL, Docker,
 * 0-1 years". The master says MongoDB and has never touched Docker. */
export const zomatoBackendIntern: ResumeDiff = {
  applicationId: 'fixture-zomato-backend-intern',
  jobTitle: 'Backend Intern',
  company: 'Zomato',
  /* Version 4 of the immutable master. Displayed so the operator knows which
   * snapshot the Auditor's verdict actually applies to. */
  masterVersion: 4,
  coverage: {
    /* Extracted from the JD. UNTRUSTED text, rendered as React children only. */
    jdKeywords: ['Node.js', 'REST APIs', 'PostgreSQL', 'Docker'],
    /* Genuinely supported by master version 4. */
    honestlyMatched: ['Node.js', 'REST APIs'],
    /* Present in the tailored resume ONLY because the Tailor invented them.
     * Splitting these out is what stops the coverage number rewarding lying:
     * honest coverage is 50%, and the 100% figure is purchased with two claims
     * that end the first technical interview. */
    matchedByFabrication: ['PostgreSQL', 'Docker'],
  },
  lines: [
    {
      id: 'line-bullet-3',
      kind: 'bullet',
      /* Master text, verbatim from section 11. */
      masterText:
        'Built a REST API with Express and Node.js for a college event portal, handling 500 users',
      masterNodeId: 'bullet_3',
      /* THE SAFE EDIT. One run, entirely traced. Same project, same 500 users,
       * same tech - reordered and reworded into the JD's language. If a
       * recruiter asks about it the operator can talk for ten minutes. This is
       * what the quiet treatment is for: it is a change, and it is fine. */
      tailoredRuns: [
        {
          text: 'Designed and shipped a production REST API in Node.js/Express serving 500+ users for a college event platform',
          verdict: 'traced',
          tracesTo: 'bullet_3',
        },
      ],
    },
    {
      id: 'line-skills',
      kind: 'skills',
      masterText:
        'JavaScript, React, Node.js, Express, MongoDB, Git, Python',
      masterNodeId: 'skills_primary',
      /* THE DANGEROUS EDIT, split into runs so the two inventions are separable
       * claims rather than one highlighted line. Reordering real skills to put
       * the JD's language first is legitimate; the two runs in the middle are
       * not, and they must not inherit the safety of their neighbours. */
      tailoredRuns: [
        {
          text: 'Node.js, Express, REST APIs, ',
          verdict: 'traced',
          tracesTo: 'skills_primary',
        },
        {
          /* Traces to nothing. The master says MongoDB. */
          text: 'PostgreSQL',
          verdict: 'fabricated',
          tracesTo: null,
        },
        {
          /* Separator carried over untouched, so it needs no verdict and no
           * marking - highlighting punctuation is how a diff becomes noise. */
          text: ', ',
          verdict: null,
          tracesTo: null,
        },
        {
          /* Traces to nothing. Never used. */
          text: 'Docker',
          verdict: 'fabricated',
          tracesTo: null,
        },
        {
          text: ', JavaScript, React, MongoDB, Git, Python',
          verdict: 'traced',
          tracesTo: 'skills_primary',
        },
      ],
    },
  ],
};

/* A clean row, so the batch-approve path is demonstrable and so the contrast
 * between the two buckets is visible in one sitting. Every run traces. */
export const swiggyFrontendIntern: ResumeDiff = {
  applicationId: 'fixture-swiggy-frontend-intern',
  jobTitle: 'Frontend Intern',
  company: 'Swiggy',
  masterVersion: 4,
  coverage: {
    jdKeywords: ['React', 'JavaScript', 'REST APIs', 'Git'],
    /* All four supported by the master, so no fabrication was needed to reach
     * full coverage - which is what an honest 100% looks like. */
    honestlyMatched: ['React', 'JavaScript', 'REST APIs', 'Git'],
    matchedByFabrication: [],
  },
  lines: [
    {
      id: 'line-bullet-1',
      kind: 'bullet',
      masterText:
        'Built a React dashboard for a college club with 12 pages and role-based access',
      masterNodeId: 'bullet_1',
      tailoredRuns: [
        {
          text: 'Built a 12-page React dashboard with role-based access control for a campus organisation',
          verdict: 'traced',
          tracesTo: 'bullet_1',
        },
      ],
    },
    {
      id: 'line-skills',
      kind: 'skills',
      masterText:
        'JavaScript, React, Node.js, Express, MongoDB, Git, Python',
      masterNodeId: 'skills_primary',
      /* Reordered to lead with the JD's language. Nothing added, nothing
       * removed - a reordering of real skills is the safest edit the Tailor can
       * make, and it still shows as a change so the operator can see it
       * happened. */
      tailoredRuns: [
        {
          text: 'React, JavaScript, Git, REST APIs, Node.js, Express, MongoDB, Python',
          verdict: 'traced',
          tracesTo: 'skills_primary',
        },
      ],
    },
  ],
};

/* The queue as the operator meets it: mixed buckets, in arrival order. The
 * Approval Queue page sorts by bucket, not this array - deciding order in the
 * page keeps the fixture an honest stand-in for a `select` result. */
export const approvalQueueFixture: readonly ResumeDiff[] = [
  zomatoBackendIntern,
  swiggyFrontendIntern,
];
