/* Checking a pasted master profile before it becomes version N+1.
 *
 * WHY AN INGEST CHECK IS THE RIGHT SHAPE FOR THIS PAGE. There is no real master
 * resume anywhere in this repo yet - only a synthetic `ResolvedResume` fixture -
 * and the master is hand-maintained JSON. So the useful thing the console can do
 * today is not a rich editor over data that does not exist; it is to take a
 * pasted profile and say precisely what is wrong with it. Ingest first, edit
 * later.
 *
 * WHY IT MATTERS MORE THAN A SCHEMA CHECK. `tsc` proves a stored profile has the
 * right SHAPE. It cannot prove the profile has the right INTEGRITY, and one
 * integrity rule here is load-bearing and enforced nowhere:
 *
 *   EVERY NODE ID MUST BE UNIQUE ACROSS THE WHOLE PROFILE - and bullet ids
 *   especially, across experience, projects AND education together.
 *
 * That is not a stylistic preference, and it is worth spelling out because the
 * consequence is invisible. The tailor validator indexes bullets with a single
 * flat `Map` keyed by bullet id, walking all three parent kinds and calling
 * `index.set(bullet.id, { bullet, parentRef: parent.id })`. A `Map` overwrites.
 * So if two bullets anywhere in the master share an id:
 *
 *   - the later one silently replaces the earlier one in the index, and
 *   - the `misattributed_bullet` check - which exists to answer "did I do this
 *     at THAT job?" - then compares the tailored bullet against the WRONG
 *     parent.
 *
 * A genuinely misattributed bullet can therefore pass the audit, or an honest
 * one be flagged, depending only on which duplicate happened to be indexed
 * last. The honesty guarantee quietly stops holding, no error is raised
 * anywhere, and the tailoring looks fine. `TailoredBullet.ref` is a bare
 * `NodeId` with no section qualifier, so there is nothing else in the system
 * that could disambiguate.
 *
 * A duplicate id is also the single most likely defect in hand-written JSON,
 * because the way anyone adds a bullet is to copy the one above it. Catching it
 * at ingest is cheap; catching it later means distrusting an audit verdict.
 *
 * WHY THIS FILE IS PURE. It takes `unknown` and returns findings. No React, no
 * network, no throwing - so it can be tested directly with `node --test`,
 * exactly like the anon-key guard. Same reasoning as `keyRole.ts`: separate the
 * pure decision from the side effect, because the decision is the part that can
 * be subtly wrong.
 */

import type { MasterProfile } from '../../data/contract';

/* --- What the check reports ------------------------------------------ */

/* Blocking versus advisory, and the distinction is not cosmetic.
 *
 * `blocking` means accepting this profile would produce a master that breaks a
 * guarantee downstream - an unresolvable ref, or a corrupted misattribution
 * check. `advisory` means the profile is valid but will disappoint: a bullet
 * with no tags is legal and simply never gets selected, which is a much better
 * thing to be told at ingest than to discover from thirty bland applications. */
export type FindingSeverity = 'blocking' | 'advisory';

export interface IngestFinding {
  readonly severity: FindingSeverity;
  /* Where in the pasted JSON, in dotted-path form the operator can search for
     in their own editor - `experience[2].bullets[0].id` rather than "a bullet".
     A finding whose location has to be hunted for is a finding that gets
     ignored. */
  readonly path: string;
  /* What is wrong AND why it matters, in one sentence. The "why" is the half
     that gets acted on; "id must be unique" invites a shrug, whereas losing the
     misattribution check does not. */
  readonly problem: string;
}

/* The outcome. Either a profile that may be stored, or the reasons it may not.
 *
 * A DISCRIMINATED UNION rather than `{ profile, findings }`, so a caller cannot
 * read `.profile` without having handled the failure case - the compiler
 * refuses. The alternative shape permits exactly the bug this whole page exists
 * to prevent: storing a profile that came back with blocking findings. */
export type IngestResult =
  | {
      readonly ok: true;
      /* Advisory findings can be present on a successful ingest - they are
         things to improve, not reasons to refuse. */
      readonly findings: readonly IngestFinding[];
      readonly profile: MasterProfile;
      readonly summary: IngestSummary;
    }
  | {
      readonly ok: false;
      /* Contains at least one blocking finding, and may contain advisory ones
         found along the way - reporting everything from one paste beats making
         the operator fix and re-paste six times. */
      readonly findings: readonly IngestFinding[];
    };

/* What was found, for the operator to sanity-check against the resume in front
 * of them. Counts rather than content: "4 experience entries, 19 bullets" is
 * how someone notices a section failed to paste. */
export interface IngestSummary {
  readonly skills: number;
  readonly experience: number;
  readonly projects: number;
  readonly education: number;
  readonly bullets: number;
  readonly links: number;
}

/* --- Narrowing helpers ------------------------------------------------ */

/* A plain JSON object. `unknown` in, so nothing here may assume a shape. */
function isRecord(value: unknown): value is Record<string, unknown> {
  /* `typeof null === 'object'` is the classic trap, and arrays are objects too
     - both must be excluded before any property read. */
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* A string with something in it. Empty and whitespace-only both count as
 * absent: a bullet whose text is a space is not a bullet, and it would render
 * as a blank line on a real resume. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/* --- The node-id ledger, which is the heart of the check ------------- */

/* Every id seen so far, with where it was seen.
 *
 * Kept as one ledger across ALL node kinds rather than per-section, because the
 * tailor validator's bullet index is itself flat. Checking uniqueness per
 * section would report a clean profile for exactly the collision that breaks
 * the audit. The check has to be shaped like the consumer, not like the
 * document. */
class IdLedger {
  /* id -> the path where it was first claimed. */
  private readonly seen = new Map<string, string>();
  private readonly findings: IngestFinding[] = [];

  /* Claim an id for a node at `path`. Reports a missing, non-string or
     duplicate id, and records nothing when the id is unusable. */
  claim(rawId: unknown, path: string, isBullet: boolean): void {
    /* An absent or blank id is blocking on its own: a node with no id can never
       be referenced, so a tailored resume can never include it. It is invisible
       content - present in the master, unreachable by the Tailor. */
    if (!isNonEmptyString(rawId)) {
      this.findings.push({
        severity: 'blocking',
        path: path + '.id',
        problem:
          'Missing or blank id. A node with no id can never be referenced by a tailored resume, so this content would sit in the master and never be selectable.',
      });
      return;
    }

    const first = this.seen.get(rawId);
    if (first !== undefined) {
      this.findings.push({
        severity: 'blocking',
        path: path + '.id',
        /* Bullets get the longer explanation because their collision is the
           one with a silent, security-shaped consequence rather than mere
           ambiguity. */
        problem: isBullet
          ? 'Duplicate bullet id "' +
            rawId +
            '", first used at ' +
            first +
            '. Bullets from experience, projects and education are indexed together in one flat map, so the second one overwrites the first - and the check that catches a bullet claimed under the wrong job then compares against the wrong parent. A misattributed bullet could pass the audit silently.'
          : 'Duplicate id "' +
            rawId +
            '", first used at ' +
            first +
            '. Ids must be unique across the whole profile, because a tailored resume refers to nodes by bare id with nothing to say which section was meant.',
      });
      return;
    }

    this.seen.set(rawId, path);
  }

  /* Findings accumulated while claiming. */
  collected(): readonly IngestFinding[] {
    return this.findings;
  }
}

/* --- Checking the parts ---------------------------------------------- */

/* Bullets belonging to one parent node. Shared by experience, projects and
 * education, because all three carry the same bullet shape - and because
 * walking them uniformly here mirrors how the validator walks them, which is
 * the property that makes the uniqueness check correct. */
function checkBullets(
  rawBullets: unknown,
  parentPath: string,
  ledger: IdLedger,
  findings: IngestFinding[],
): number {
  /* A parent with no bullets array at all is blocking: the field is required by
     the contract, and its absence is far more likely to be a paste that lost a
     section than a deliberate choice. */
  if (!Array.isArray(rawBullets)) {
    findings.push({
      severity: 'blocking',
      path: parentPath + '.bullets',
      problem:
        'Missing or not an array. Every experience, project and education node carries a bullets array, even if it is empty.',
    });
    return 0;
  }

  /* An empty array is legal but pointless - the node can appear on a resume
     with a heading and nothing under it. Advisory, not blocking. */
  if (rawBullets.length === 0) {
    findings.push({
      severity: 'advisory',
      path: parentPath + '.bullets',
      problem:
        'No bullets. This node can still be selected, but it would render as a heading with nothing underneath it.',
    });
  }

  let counted = 0;
  rawBullets.forEach((rawBullet, index) => {
    const path = parentPath + '.bullets[' + String(index) + ']';

    if (!isRecord(rawBullet)) {
      findings.push({
        severity: 'blocking',
        path,
        problem: 'Not an object. Each bullet is { id, text, tags }.',
      });
      return;
    }

    /* `isBullet` true: this is the collision that corrupts the misattribution
       check, so it gets the longer explanation. */
    ledger.claim(rawBullet['id'], path, true);

    /* THE GROUND TRUTH. Every reworded line the Tailor produces is checked
       against this text, so a blank one means there is nothing to check a
       rewording against - the honesty guarantee has no anchor. */
    if (!isNonEmptyString(rawBullet['text'])) {
      findings.push({
        severity: 'blocking',
        path: path + '.text',
        problem:
          'Missing or blank text. This string is the ground truth a reworded bullet is audited against, so an empty one leaves the rewording with nothing to be checked against.',
      });
    }

    const tags = rawBullet['tags'];
    if (!Array.isArray(tags)) {
      findings.push({
        severity: 'blocking',
        path: path + '.tags',
        problem: 'Missing or not an array. Use an empty array if there are no tags.',
      });
    } else if (tags.length === 0) {
      /* Legal, and quietly costly: tags are how the Tailor decides a bullet is
         relevant to a job. An untagged bullet is not invalid, it is invisible -
         which is worth knowing now rather than after thirty applications that
         all omitted it. */
      findings.push({
        severity: 'advisory',
        path: path + '.tags',
        problem:
          'No tags. Tags are how the Tailor decides this bullet is relevant to a job, so an untagged bullet will rarely or never be selected.',
      });
    }

    counted += 1;
  });

  return counted;
}

/* The verbatim display dates. Both are required and both are printed exactly as
 * written: the renderer does no date maths at all, deliberately, because `Date`
 * and `Intl` make output depend on the host timezone and ICU build - which
 * would let a Windows preview and the Ubuntu runner's PDF differ while every
 * test passed. So a missing display date is a blank on the resume, not a date
 * computed from the ISO field. */
function checkDisplayDates(
  node: Record<string, unknown>,
  path: string,
  findings: IngestFinding[],
): void {
  for (const field of ['start_display', 'end_display'] as const) {
    if (!isNonEmptyString(node[field])) {
      findings.push({
        severity: 'blocking',
        path: path + '.' + field,
        problem:
          'Missing or blank. This string is printed on the resume exactly as written - the renderer performs no date maths, so nothing will fill it in. Use "Present" for a current role.',
      });
    }
  }
}

/* One dated, bulleted node - experience, project or education. The three differ
 * only in which identifying text fields they require, so those are passed in
 * rather than triplicating the walk. */
function checkDatedNode(
  raw: unknown,
  path: string,
  requiredText: readonly string[],
  ledger: IdLedger,
  findings: IngestFinding[],
): number {
  if (!isRecord(raw)) {
    findings.push({
      severity: 'blocking',
      path,
      problem: 'Not an object.',
    });
    return 0;
  }

  ledger.claim(raw['id'], path, false);

  /* The fields that identify the node on the page. A nameless job is not
     something a resume can render honestly. */
  for (const field of requiredText) {
    if (!isNonEmptyString(raw[field])) {
      findings.push({
        severity: 'blocking',
        path: path + '.' + field,
        problem: 'Missing or blank, and it is printed on the resume.',
      });
    }
  }

  checkDisplayDates(raw, path, findings);
  return checkBullets(raw['bullets'], path, ledger, findings);
}

/* --- The entry point -------------------------------------------------- */

/* Check a parsed-but-unvalidated master profile.
 *
 * Takes `unknown` because it is fed `JSON.parse` output. Never throws: a paste
 * check that can crash is a paste check that loses the operator's paste. */
export function checkMasterProfile(raw: unknown): IngestResult {
  const findings: IngestFinding[] = [];
  const ledger = new IdLedger();

  /* Nothing else can be checked if the top level is not an object, so this
     returns rather than accumulating a cascade of misleading findings about
     missing sections. */
  if (!isRecord(raw)) {
    return {
      ok: false,
      findings: [
        {
          severity: 'blocking',
          path: '(root)',
          problem:
            'The pasted text is not a JSON object. A master profile is a single object with identity, education, experience, projects, skills and links.',
        },
      ],
    };
  }

  /* The version gate exists so an old stored profile is DETECTED rather than
     misread. Accepting an unknown version would mean reading fields that may
     have changed meaning, which is worse than refusing. */
  if (raw['schema_version'] !== 1) {
    findings.push({
      severity: 'blocking',
      path: 'schema_version',
      problem:
        'Must be exactly 1. This field exists so a profile written against an older shape is detected instead of being read as though its fields still mean the same thing.',
    });
  }

  /* --- Identity, copied verbatim and never tailored ------------------ */

  const identity = raw['identity'];
  if (!isRecord(identity)) {
    findings.push({
      severity: 'blocking',
      path: 'identity',
      problem: 'Missing or not an object. Name and email live here.',
    });
  } else {
    /* Only these two are truly required: a resume with no name or no way to
       reply to it cannot do its job. Phone, location and headline are
       legitimately optional and the contract types them nullable. */
    for (const field of ['full_name', 'email'] as const) {
      if (!isNonEmptyString(identity[field])) {
        findings.push({
          severity: 'blocking',
          path: 'identity.' + field,
          problem:
            'Missing or blank. Identity is copied verbatim into every resume and is never tailored, so nothing downstream can supply it.',
        });
      }
    }

    /* Identity links share the global id space, so they are claimed too - a
       link id colliding with a bullet id is exactly as ambiguous as any other
       collision. */
    const identityLinks = identity['links'];
    if (!Array.isArray(identityLinks)) {
      findings.push({
        severity: 'blocking',
        path: 'identity.links',
        problem: 'Missing or not an array. Use an empty array if there are none.',
      });
    } else {
      identityLinks.forEach((link, index) => {
        const path = 'identity.links[' + String(index) + ']';
        if (!isRecord(link)) {
          findings.push({ severity: 'blocking', path, problem: 'Not an object.' });
          return;
        }
        ledger.claim(link['id'], path, false);
        for (const field of ['label', 'url'] as const) {
          if (!isNonEmptyString(link[field])) {
            findings.push({
              severity: 'blocking',
              path: path + '.' + field,
              problem: 'Missing or blank.',
            });
          }
        }
      });
    }
  }

  /* --- Skills, the atomic never-reworded nodes ----------------------- */

  const skills = raw['skills'];
  let skillCount = 0;
  if (!Array.isArray(skills)) {
    findings.push({
      severity: 'blocking',
      path: 'skills',
      problem: 'Missing or not an array.',
    });
  } else {
    skills.forEach((skill, index) => {
      const path = 'skills[' + String(index) + ']';
      if (!isRecord(skill)) {
        findings.push({ severity: 'blocking', path, problem: 'Not an object.' });
        return;
      }
      ledger.claim(skill['id'], path, false);
      /* A skill is either in the master or it does not exist - there is no free
         text for one anywhere in the pipeline. So a blank name here is a skill
         that can be selected and then rendered as nothing. */
      for (const field of ['name', 'category'] as const) {
        if (!isNonEmptyString(skill[field])) {
          findings.push({
            severity: 'blocking',
            path: path + '.' + field,
            problem:
              'Missing or blank. A skill is atomic and never reworded, so this exact string is what appears on the resume.',
          });
        }
      }
      skillCount += 1;
    });

    /* Legal but consequential: with no skills, every keyword the Tailor is
       asked to match has nothing honest to match against, so coverage is zero
       and stays zero. Advisory because an empty master is a valid starting
       point. */
    if (skills.length === 0) {
      findings.push({
        severity: 'advisory',
        path: 'skills',
        problem:
          'No skills. Keyword coverage against every job description will be zero, because a skill can only appear on a resume if it is in this list.',
      });
    }
  }

  /* --- The three bulleted sections ----------------------------------- */

  let bulletCount = 0;

  /* Walked in one loop so all three get identical treatment - and so bullets
     from all three land in ONE ledger, which is the whole point. */
  const sections: readonly {
    key: 'experience' | 'projects' | 'education';
    requiredText: readonly string[];
  }[] = [
    { key: 'experience', requiredText: ['company', 'role'] },
    { key: 'projects', requiredText: ['name'] },
    { key: 'education', requiredText: ['institution', 'degree'] },
  ];

  const counts: Record<string, number> = {};
  for (const section of sections) {
    const value = raw[section.key];
    if (!Array.isArray(value)) {
      findings.push({
        severity: 'blocking',
        path: section.key,
        problem: 'Missing or not an array. Use an empty array if there are none.',
      });
      counts[section.key] = 0;
      continue;
    }
    counts[section.key] = value.length;
    value.forEach((node, index) => {
      bulletCount += checkDatedNode(
        node,
        section.key + '[' + String(index) + ']',
        section.requiredText,
        ledger,
        findings,
      );
    });
  }

  /* Nothing to rework at all. The Tailor selects and rewords bullets, so a
     master with none can only ever produce a resume of identity and skills. */
  if ((counts['experience'] ?? 0) === 0 && (counts['projects'] ?? 0) === 0) {
    findings.push({
      severity: 'advisory',
      path: '(root)',
      problem:
        'No experience and no projects. Every tailored bullet must reword one from this master, so there would be nothing for the Tailor to select.',
    });
  }

  /* --- Top-level links ----------------------------------------------- */

  const links = raw['links'];
  let linkCount = 0;
  if (!Array.isArray(links)) {
    findings.push({
      severity: 'blocking',
      path: 'links',
      problem: 'Missing or not an array. Use an empty array if there are none.',
    });
  } else {
    links.forEach((link, index) => {
      const path = 'links[' + String(index) + ']';
      if (!isRecord(link)) {
        findings.push({ severity: 'blocking', path, problem: 'Not an object.' });
        return;
      }
      ledger.claim(link['id'], path, false);
      linkCount += 1;
    });
  }

  /* --- Verdict -------------------------------------------------------- */

  /* Ledger findings come last so that field-level problems within a node are
     reported next to the node, and id collisions read as a group. */
  const all = [...findings, ...ledger.collected()];
  const blocking = all.filter((finding) => finding.severity === 'blocking');

  if (blocking.length > 0) {
    /* Deliberately does NOT return a profile. The union makes it impossible for
       a caller to store one anyway, which is the point of the union. */
    return { ok: false, findings: all };
  }

  return {
    ok: true,
    findings: all,
    /* The cast is confined to this one line and is earned: every field the
       contract requires has just been checked above. Casting at the top and
       checking afterwards would be the same code with none of the safety. */
    profile: raw as unknown as MasterProfile,
    summary: {
      skills: skillCount,
      experience: counts['experience'] ?? 0,
      projects: counts['projects'] ?? 0,
      education: counts['education'] ?? 0,
      bullets: bulletCount,
      links: linkCount,
    },
  };
}

/* Parse and check in one step, since the operator pastes text rather than an
 * object. Kept separate from `checkMasterProfile` so the checker stays testable
 * with structured input rather than only through a JSON round-trip. */
export function ingestMasterProfileText(text: string): IngestResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      findings: [
        {
          severity: 'blocking',
          path: '(root)',
          /* The parser's own message names the offset, which is the single most
             useful thing when the paste is a few thousand characters long. */
          problem:
            'Not valid JSON: ' +
            (error instanceof Error ? error.message : 'unknown parse error'),
        },
      ],
    };
  }
  return checkMasterProfile(parsed);
}
