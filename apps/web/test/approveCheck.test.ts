/* checkBeforeApprove: the auditor's own check, run again when Teja approves an EDITED row
 * (Teja, 2026-11-05: "Check on Approve, hold for a 2nd click"). The auditor runs once, at
 * tailored -> audit_clean|audit_flagged; an edit made later at awaiting_approval was never re-checked
 * before the worker submitted it. These tests pin three things the orchestrator's spec requires:
 * the same verdict as the auditor, the row's CURRENT pinned master (an attested skill must not
 * false-flag), and fail-closed on anything unexpected (never a silent pass). */

// Strict asserts: deepEqual compares shapes exactly.
import assert from 'node:assert/strict';
// The runner the web suite uses.
import { describe, it } from 'node:test';

// The check under test.
import { checkBeforeApprove } from '../src/features/approval/approveCheck.ts';
// The contract types the auditor reads, so a fixture that drifts from them fails typecheck.
import type { MasterProfile, ResolvedResume } from '../src/data/contract';

/* A master with one job and two skills: the smallest profile the auditor can judge every
   section of. Text matches the resume below exactly, so the unedited resume is clean. */
const MASTER: MasterProfile = {
  schema_version: 1,
  identity: { full_name: 'Test Person', headline: 'Backend Engineer', email: 'test@example.com', phone: null, location: 'Hyderabad', links: [] },
  summary: { id: 'sum-1', text: 'Backend engineer experienced with Node.js and Express.' },
  education: [],
  experience: [
    {
      id: 'exp-1',
      company: 'Event Cell',
      role: 'Backend Intern',
      location: 'Hyderabad',
      start_display: 'Jun 2025',
      end_display: 'Aug 2025',
      start_date: null,
      end_date: null,
      bullets: [{ id: 'b-exp-1', text: 'Built a REST API with Express and Node.js, handling 500 users', tags: [] }],
    },
  ],
  projects: [],
  skills: [
    { id: 's-node', name: 'Node.js', category: 'Frameworks' },
    { id: 's-express', name: 'Express', category: 'Frameworks' },
  ],
  achievements: [],
  certifications: [],
  links: [],
} as MasterProfile;

/* The resume built from MASTER; `bullet` swaps the one bullet's text (an operator's edit), and
   `skills` the printed skills (an attested skill). */
function resume({ bullet, skills }: { bullet?: string; skills?: ResolvedResume['skills'] } = {}): ResolvedResume {
  // One object literal, so each test reads as "the clean resume, except ...".
  return {
    schema_version: 1,
    master_version: 1,
    identity: MASTER.identity,
    section_order: ['skills', 'experience'],
    summary: 'Backend engineer experienced with Node.js and Express.',
    skills: skills ?? [
      { ref: 's-node', name: 'Node.js', category: 'Frameworks' },
      { ref: 's-express', name: 'Express', category: 'Frameworks' },
    ],
    experience: [
      {
        ref: 'exp-1',
        company: 'Event Cell',
        role: 'Backend Intern',
        location: 'Hyderabad',
        start_display: 'Jun 2025',
        end_display: 'Aug 2025',
        bullets: [
          {
            ref: 'b-exp-1',
            text: bullet ?? 'Built a REST API with Express and Node.js, handling 500 users',
            master_text: 'Built a REST API with Express and Node.js, handling 500 users',
          },
        ],
      },
    ],
    projects: [],
    education: [],
    achievements: [],
    certifications: [],
  } as ResolvedResume;
}

describe('checkBeforeApprove', () => {
  // The positive shape: without it, "hold every edited row" would pass every test below.
  it('passes an edited row whose words all trace to the master', () => {
    // An edit that only reorders the master's own words.
    const edited = resume({ bullet: 'Built a REST API with Node.js and Express, handling 500 users' });
    // Clean, so Approve goes through on the first click.
    assert.deepEqual(checkBeforeApprove(MASTER, edited, null), { kind: 'clean' });
  });

  it('flags an edit that adds a number or a word the master lacks, quoting the claim', () => {
    // 500 inflated to 5000, and Kafka invented.
    const edited = resume({ bullet: 'Built a REST API with Express and Node.js on Kafka, handling 5000 users' });
    // The auditor's own verdict.
    const check = checkBeforeApprove(MASTER, edited, null);
    // Flagged, never clean.
    assert.equal(check.kind, 'flagged');
    // The finding quotes the edited words so the card can show them.
    assert.ok(check.kind === 'flagged' && check.findings.some((finding) => finding.claim.includes('5000')));
  });

  /* The attest re-pin (spec item 2): attesting a skill makes a NEW master version that has the skill,
     and re-pins the row to it. Checked against that master, the skill is grounded. */
  it('audits against the row\'s CURRENT pinned master, so an attested skill does not false-flag', () => {
    // The master version the attest created: the old one plus the vouched-for skill.
    const repinned = { ...MASTER, skills: [...MASTER.skills, { id: 's-dbms', name: 'DBMS', category: 'Core' }] } as MasterProfile;
    // The resume now prints it, by the new node's ref.
    const withSkill = resume({ skills: [...resume().skills, { ref: 's-dbms', name: 'DBMS', category: 'Core' }] });
    // Against the re-pinned master: clean.
    assert.deepEqual(checkBeforeApprove(repinned, withSkill, null), { kind: 'clean' });
    // Non-vacuity: against the OLD master the same skill is ungrounded, so the master argument matters.
    assert.equal(checkBeforeApprove(MASTER, withSkill, null).kind, 'flagged');
  });

  // Fail closed (spec item 1): every way the check cannot run is "could not verify", never clean.
  it('reads a missing master, a missing resume or malformed tailor refs as unverified', () => {
    // The kinds, in input order.
    const kinds = [
      checkBeforeApprove(undefined, resume(), null).kind,
      checkBeforeApprove(MASTER, undefined, null).kind,
      checkBeforeApprove(MASTER, resume(), 'not an object').kind,
      checkBeforeApprove(MASTER, resume(), ['an', 'array']).kind,
    ];
    // None of them passes.
    assert.deepEqual(kinds, ['unverified', 'unverified', 'unverified', 'unverified']);
  });

  it('reads a check that throws as unverified, with the reason', () => {
    // A resume without its sections: the detector walks them and throws.
    const check = checkBeforeApprove(MASTER, {} as ResolvedResume, null);
    // Not a pass.
    assert.equal(check.kind, 'unverified');
    // Says why, so the card is never a bare "could not check".
    assert.ok(check.kind === 'unverified' && check.why.length > 0);
  });

  /* The REAL row shape (the anonymised live GitLab row): unedited, it must re-check clean, or the hold
     would fire on every real approval and Teja would learn to click through it. Then one invented
     word in one real bullet must flag, so the pass is not a check that sees nothing. */
  it('re-checks the live row shape clean as stored, and flags one invented word in it', async () => {
    // The live row's three jsonb values.
    const live = await import('./fixtures/gitlab-row-anonymised.ts');
    // Parsed through the page's own master gate, as the page does on load.
    const master = (await import('../src/features/approval/tailoredEdits.ts')).masterFromRow(live.MASTER_V2);
    // The fixture must parse, or the rest proves nothing.
    assert.notEqual(master, null, 'fixture master_v2 must parse');
    // As stored: clean.
    assert.deepEqual(checkBeforeApprove(master!, live.STORED_TAILORED_PROFILE as never, live.TAILOR_REFS), { kind: 'clean' });
    // A copy with one real bullet edited to carry a word no master node has.
    const edited = structuredClone(live.STORED_TAILORED_PROFILE) as { experience: { bullets: { text: string }[] }[] };
    // The first experience bullet, as the operator would type over it.
    edited.experience[0]!.bullets[0]!.text += ' using Zanzibarql';
    // Flagged.
    assert.equal(checkBeforeApprove(master!, edited as never, live.TAILOR_REFS).kind, 'flagged');
  });

  // The answer's shape is checked, not trusted: a lenient read of a bad answer is the fail-open.
  it('reads an answer of the wrong shape, or a verdict its findings contradict, as unverified', () => {
    // A finding with no claim.
    const noClaim = () => ({ status: 'audit_flagged' as const, findings: [{ kind: 'other', path: 'x' }] as never });
    // "Clean" while listing a finding.
    const contradicts = () => ({ status: 'audit_clean' as const, findings: [{ kind: 'other', path: 'x', claim: 'c', reason: 'r', confidence: null }] as never });
    // No findings array at all.
    const noArray = () => ({ status: 'audit_clean' as const }) as never;
    // Each one, through the same seam the page uses.
    const kinds = [noClaim, contradicts, noArray].map((audit) => checkBeforeApprove(MASTER, resume(), null, audit).kind);
    // None passes.
    assert.deepEqual(kinds, ['unverified', 'unverified', 'unverified']);
  });
});
