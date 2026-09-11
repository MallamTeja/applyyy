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

/* THE GLOBAL NODE-ID UNIQUENESS RULE, IMPORTED RATHER THAN REIMPLEMENTED.
 *
 * This file used to carry its own duplicate detector inside `IdLedger`. It was
 * correct - it used one flat ledger across every kind - but being correct was
 * not the point. `node-id-uniqueness.ts:21-27` records why a second
 * implementation is dangerous regardless of whether today's copy is right: the
 * PER-SECTION checker is the plausible wrong design, it is the more
 * natural-reading one, and it passed 34 of 36 tests written against this very
 * ingest path. The only two it failed were a cross-section collision and a
 * bullet id colliding with a skill id. `docs/verification-traps.md` instance 21
 * records the same result reproduced independently in the reconciler. So every
 * fresh implementation of this rule is a fresh chance to write the wrong one,
 * and it would look correct and test green.
 *
 * One home, therefore, and this is the import that makes it one. */
import { findDuplicateNodeIds } from '@applyy/master-ingest';

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
  /* Added 2026-09-11 with the contract change that gave achievements and
     certifications real nodes. THEY NEED THEIR OWN COUNTS FOR THE REASON THE
     COUNTS EXIST AT ALL: this block is how an operator notices a section
     silently failed to paste, and a section with no count is precisely the one
     that can vanish unnoticed. Before the parser existed, ingest was silently
     truncating both. */
  readonly achievements: number;
  readonly certifications: number;
  readonly bullets: number;
  /* EVERY link in the profile, across all THREE arrays that now carry them -
     `identity.links`, `projects[i].links` and the top-level `links`. One total
     rather than three, because the operator is checking "did my links survive
     the paste", not auditing which array each landed in. */
  readonly links: number;
  /* Whether a summary node is present. A BOOLEAN, NOT A COUNT, because
     `MasterProfile.summary` is a single nullable node rather than an array -
     "1 summary" would imply there could be two, and the contract is explicit
     that there is one and selection is not the operation. */
  readonly hasSummary: boolean;
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

/* --- Node ids: presence here, uniqueness in the package --------------- */

/* WHY THIS CHECK IS SPLIT IN TWO, AND WHERE THE SEAM IS.
 *
 * Two different questions get asked about node ids, and they need different
 * inputs:
 *
 *   PRESENCE - "does this node have a usable id at all?" - has to run over
 *   `unknown`, interleaved with the structural walk, because the answer is
 *   often "the id is the number 7" or "there is no id field". That question
 *   lives below, in `IdPresenceLedger`.
 *
 *   UNIQUENESS - "is this id claimed twice anywhere in the profile?" - is
 *   answered by `findDuplicateNodeIds` in `@applyy/master-ingest`, which is the
 *   one home for that rule. But it takes a typed `MasterProfile` and reads
 *   `profile.identity.links`, `profile.skills` and so on with NO guards, so
 *   handing it raw `JSON.parse` output would throw a TypeError on the first
 *   property access of a malformed paste. This module's contract forbids that:
 *   "Never throws: a paste check that can crash is a paste check that loses the
 *   operator's paste."
 *
 * So uniqueness runs LAST, over a profile whose shape has already been proven
 * by the walk. That ordering is not a workaround - it is the honest reading.
 * "Are these ids unique" is not a meaningful question about a document in which
 * ids are missing or `skills` is an object; the walk has to answer first.
 *
 * THE COST, STATED RATHER THAN HIDDEN. This file otherwise reports everything
 * from one paste, because making the operator fix and re-paste six times is how
 * a checker stops being used. A profile with BOTH a structural error AND a
 * duplicate id now takes two rounds: the structural error, then the duplicate.
 * That is a real regression in a compound case, accepted because the
 * alternative is a permanent second implementation of the one rule whose wrong
 * version is invisible. */

/* Ids that are missing or unusable. Uniqueness is NOT its business - see above.
 *
 * Still a class rather than a free function because it accumulates across a
 * walk that touches six different node kinds, and threading an array through
 * every one of them was the shape this replaced. */
class IdPresenceLedger {
  private readonly findings: IngestFinding[] = [];

  /* Record whether the node at `path` has a usable id. */
  claim(rawId: unknown, path: string): void {
    /* An absent or blank id is blocking on its own: a node with no id can never
       be referenced, so a tailored resume can never include it. It is invisible
       content - present in the master, unreachable by the Tailor.
       This is also the check `findDuplicateNodeIds` structurally CANNOT make:
       it compares ids to each other, so a single node carrying `undefined`
       looks unique to it and passes. Losing this branch was the concrete cost
       of the delete-and-replace this seam exists instead of. */
    if (!isNonEmptyString(rawId)) {
      this.findings.push({
        severity: 'blocking',
        path: path + '.id',
        problem:
          'Missing or blank id. A node with no id can never be referenced by a tailored resume, so this content would sit in the master and never be selectable.',
      });
    }
  }

  /* Findings accumulated while claiming. */
  collected(): readonly IngestFinding[] {
    return this.findings;
  }
}

/* Turn the package's duplicate report into this file's finding shape.
 *
 * The two vocabularies differ on purpose: the package returns `{ id, paths }`
 * because it serves several callers, and this file renders one finding per
 * problem with a dotted path an operator can search for. Translating here keeps
 * the package free of UI copy. */
function duplicateFindings(profile: MasterProfile): readonly IngestFinding[] {
  const findings: IngestFinding[] = [];

  for (const duplicate of findDuplicateNodeIds(profile)) {
    /* ONE FINDING PER OCCURRENCE AFTER THE FIRST, in document order.
       `collectNodeIds` returns document order, and the convention is to report
       on the later occurrences and name the first in the sentence.

       WHY A CONVENTION AND NOT A DEDUCTION, because the obvious reading of this
       code overstates what it knows. Within one section, the later occurrence
       really is the copy - the way anyone adds a bullet is to duplicate the one
       above it - so putting the finding there points at the line to edit. ACROSS
       kinds it decides nothing: the walk visits `summary` before `experience`,
       so a summary colliding with an experience bullet reports on the BULLET,
       which may well be the older node. Neither end is knowably the culprit and
       document order cannot tell you.

       That is why every finding names the other end in its message and why
       there is one finding per later occurrence rather than one per id: the
       operator has to see both halves and decide which to renumber, and a
       three-way collision is two separate edits. */
    const [first, ...copies] = duplicate.paths;
    /* Cannot happen - `findDuplicateNodeIds` only returns ids with more than
       one path - but `noUncheckedIndexedAccess` types it as possibly undefined,
       and a non-null assertion here would be the one place this file lies to
       the compiler. */
    if (first === undefined) continue;

    for (const path of copies) {
      findings.push(duplicateFinding(duplicate.id, path, first, duplicate.paths));
    }
  }

  return findings;
}

/* One finding for one duplicated occurrence.
 *
 * Takes the offending path and the first one separately rather than the whole
 * group, because the sentence has to name exactly those two roles: where the
 * problem is, and where the id was already spoken for. */
function duplicateFinding(
  id: string,
  path: string,
  firstPath: string,
  allPaths: readonly string[],
): IngestFinding {
  /* Whether this collision involves a BULLET decides how alarming the sentence
     should be, so it has to be recoverable. Read off the paths rather than
     tracked separately, which is sound because the package documents that its
     paths use this file's own dotted convention (`node-id-uniqueness.ts:46-48`)
     - so `.bullets[` is a contract, not a coincidence of formatting.

     Checked across ALL paths rather than just this one: a bullet id colliding
     with a SKILL id is one of the two cases the wrong per-section design
     missed, and it deserves the bullet explanation even when the end being
     reported is the skill. */
  const involvesBullet = allPaths.some((candidate) => candidate.includes('.bullets['));

  return {
    severity: 'blocking',
    /* Anchored on the COPY, which is the line the operator has to edit. */
    path: path + '.id',
    /* Bullets get the longer explanation because their collision is the one
       with a silent, security-shaped consequence rather than mere ambiguity.
       Both forms name the FIRST location, because a collision the operator can
       only see one half of is one they cannot fix. */
    problem: involvesBullet
      ? 'Duplicate bullet id "' +
        id +
        '", first used at ' +
        firstPath +
        '. Bullets from experience, projects and education are indexed together in one flat map, so the second one overwrites the first - and the check that catches a bullet claimed under the wrong job then compares against the wrong parent. A misattributed bullet could pass the audit silently.'
      : 'Duplicate id "' +
        id +
        '", first used at ' +
        firstPath +
        '. Ids must be unique across the whole profile, because a tailored resume refers to nodes by bare id with nothing to say which section was meant.',
  };
}

/* --- Checking the parts ---------------------------------------------- */

/* Bullets belonging to one parent node. Shared by experience, projects and
 * education, because all three carry the same bullet shape - and because
 * walking them uniformly here mirrors how the validator walks them, which is
 * the property that makes the uniqueness check correct. */
function checkBullets(
  rawBullets: unknown,
  parentPath: string,
  ledger: IdPresenceLedger,
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
    ledger.claim(rawBullet['id'], path);

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
  ledger: IdPresenceLedger,
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

  ledger.claim(raw['id'], path);

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

/* One undated, bulleted node - an achievement or a certification.
 *
 * WHY THIS IS NOT `checkDatedNode` WITH AN EMPTY DATE LIST. Achievements and
 * certifications have NO date fields, and `profile-nodes.ts:272` says that is a
 * decision rather than an omission: the real resume writes them as undated
 * lines, so a date field would have one honest value - empty - and one tempting
 * dishonest one, a date the parser inferred. Reusing the dated walk and passing
 * no required dates would have worked today and quietly invited someone to
 * "fix" the missing dates later. A separate function makes the absence
 * deliberate and visible.
 *
 * `description` is NOT required and is not checked: the contract types it
 * `string | null`, because the qualifying detail after the label is genuinely
 * absent on many lines. */
function checkUndatedNode(
  raw: unknown,
  path: string,
  ledger: IdPresenceLedger,
  findings: IngestFinding[],
): number {
  if (!isRecord(raw)) {
    findings.push({ severity: 'blocking', path, problem: 'Not an object.' });
    return 0;
  }

  ledger.claim(raw['id'], path);

  /* The label is the line itself - "Winner, Smart India Hackathon 2025" - and
     it is copied verbatim onto the resume, so a blank one renders as an empty
     bullet under a real heading. */
  if (!isNonEmptyString(raw['label'])) {
    findings.push({
      severity: 'blocking',
      path: path + '.label',
      problem:
        'Missing or blank label. This string is the achievement or certification itself and is copied onto the resume verbatim, so nothing downstream can supply it.',
    });
  }

  /* Bullets descend here too, and this is the part a new node kind gets wrong:
     the parent id is obvious because it is the thing being added, while the
     bullets underneath are a second id-bearing place nobody remembers.
     `node-id-uniqueness.ts` calls out the same trap in its own walk. */
  return checkBullets(raw['bullets'], path, ledger, findings);
}

/* A link array. Shared by all THREE arrays that carry one.
 *
 * WHY THIS IS ONE FUNCTION. `identity.links` and the top-level `links` used to
 * be walked by two inline blocks that had already drifted: identity's required
 * `label` and `url`, the top-level one claimed the id and checked neither. So a
 * blank-labelled top-level link was accepted and would render as an empty
 * anchor. `projects[i].links` arriving on 2026-09-11 would have made that three
 * copies and a second chance to drift, which is the same argument that moved
 * the uniqueness rule into the package. */
function checkLinkArray(
  rawLinks: unknown,
  arrayPath: string,
  ledger: IdPresenceLedger,
  findings: IngestFinding[],
): number {
  /* Required even when empty. An absent array is far more likely to be a paste
     that lost a section than a deliberate choice, and the contract types it as
     a present-possibly-empty array for exactly that reason. */
  if (!Array.isArray(rawLinks)) {
    findings.push({
      severity: 'blocking',
      path: arrayPath,
      problem: 'Missing or not an array. Use an empty array if there are none.',
    });
    return 0;
  }

  let counted = 0;
  rawLinks.forEach((link, index) => {
    const path = arrayPath + '[' + String(index) + ']';
    if (!isRecord(link)) {
      findings.push({ severity: 'blocking', path, problem: 'Not an object.' });
      return;
    }
    ledger.claim(link['id'], path);
    /* Both are printed: the label is the anchor text and the url is where it
       goes, so neither has a sensible blank rendering. */
    for (const field of ['label', 'url'] as const) {
      if (!isNonEmptyString(link[field])) {
        findings.push({
          severity: 'blocking',
          path: path + '.' + field,
          problem: 'Missing or blank.',
        });
      }
    }
    counted += 1;
  });

  return counted;
}

/* The master summary - one node, or none.
 *
 * NULL IS A LEGITIMATE VALUE AND IS NOT A FINDING. `MasterProfile.summary` is a
 * required FIELD with a nullable VALUE, so `null` means "this resume has no
 * summary paragraph", which is ordinary. What is NOT ordinary is the field
 * being absent entirely, or holding something that is neither null nor a node -
 * both would sail past into the cast at the end of this file.
 *
 * Returns whether a summary is present, for the count block. */
function checkSummary(
  raw: Record<string, unknown>,
  ledger: IdPresenceLedger,
  findings: IngestFinding[],
): boolean {
  /* `in` rather than a truthiness test, because `null` is the common valid
     value and `raw['summary'] === undefined` cannot distinguish "absent" from
     "present and explicitly undefined" - only one of which the contract
     permits. */
  if (!('summary' in raw)) {
    findings.push({
      severity: 'blocking',
      path: 'summary',
      problem:
        'Missing. Use null if this resume has no summary paragraph - the field is required even when there is nothing in it, so that a profile which simply forgot it is distinguishable from one that deliberately has none.',
    });
    return false;
  }

  const summary = raw['summary'];
  /* The ordinary no-summary case. Nothing to claim, nothing to report. */
  if (summary === null) {
    return false;
  }

  if (!isRecord(summary)) {
    findings.push({
      severity: 'blocking',
      path: 'summary',
      problem: 'Not an object and not null. A summary is { id, text }, or null when there is none.',
    });
    return false;
  }

  /* THE ID IS THE WHOLE REASON THIS IS A NODE. `profile-nodes.ts:242` records
     that the summary stopped being a bare string precisely so a reworded
     summary could point at something - without an id, "reword my summary" is
     indistinguishable from "invent a summary". */
  ledger.claim(summary['id'], 'summary');

  /* Ground truth for any rewording that refs it, same role as a bullet's text -
     so a blank one leaves the rewording with nothing to be audited against. */
  if (!isNonEmptyString(summary['text'])) {
    findings.push({
      severity: 'blocking',
      path: 'summary.text',
      problem:
        'Missing or blank text. This paragraph is the ground truth a reworded summary is audited against, so an empty one leaves the rewording with nothing to be checked against.',
    });
  }

  return true;
}

/* --- The entry point -------------------------------------------------- */

/* Check a parsed-but-unvalidated master profile.
 *
 * Takes `unknown` because it is fed `JSON.parse` output. Never throws: a paste
 * check that can crash is a paste check that loses the operator's paste. */
export function checkMasterProfile(raw: unknown): IngestResult {
  const findings: IngestFinding[] = [];
  const ledger = new IdPresenceLedger();

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

  /* Declared out here because links live in three different places and the
     summary count is reported as one total. Initialised to zero so a missing
     identity block contributes nothing rather than making the total NaN. */
  let identityLinkCount = 0;

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
       collision. Counted into the same total as the other two link arrays. */
    identityLinkCount = checkLinkArray(identity['links'], 'identity.links', ledger, findings);
  }

  /* --- The summary, one node or none --------------------------------- */

  /* Checked at the top level rather than inside identity, matching where the
     contract puts it: a summary is authored content that gets reworded, not an
     identifying fact that is copied verbatim. */
  const hasSummary = checkSummary(raw, ledger, findings);

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
      ledger.claim(skill['id'], path);
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

  /* --- The three DATED bulleted sections ----------------------------- */

  let bulletCount = 0;
  /* Links found nested under projects, added to the same total as the other two
     arrays. Declared here because the section loop is where they are found. */
  let projectLinkCount = 0;

  /* Walked in one loop so all three get identical treatment - and so bullets
     from all three land in ONE ledger, which is the whole point. */
  const sections: readonly {
    key: 'experience' | 'projects' | 'education';
    requiredText: readonly string[];
    /* Whether this kind carries its own nested link array. TRUE FOR PROJECTS
       ONLY, since 2026-09-11: `MasterProject.url: string | null` was REPLACED
       by `links: DocumentOrdered<MasterLink>`. The replacement is what makes
       this flag necessary rather than cosmetic - the old scalar carried no id,
       so there was nothing to collide or to leave unchecked; the new one draws
       a `NodeId` from the same global pool as every other node. A walk that
       skipped it would accept a project link whose id collided with a bullet's,
       silently, with the whole suite green. */
    readonly hasLinks: boolean;
  }[] = [
    { key: 'experience', requiredText: ['company', 'role'], hasLinks: false },
    { key: 'projects', requiredText: ['name'], hasLinks: true },
    { key: 'education', requiredText: ['institution', 'degree'], hasLinks: false },
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
      const path = section.key + '[' + String(index) + ']';
      bulletCount += checkDatedNode(node, path, section.requiredText, ledger, findings);
      /* The nested links, walked only for the kind that has them and only once
         the node is known to be an object - `checkDatedNode` has already
         reported it if not, and reading `.links` off a non-object would be the
         crash this file promises never to do. */
      if (section.hasLinks && isRecord(node)) {
        projectLinkCount += checkLinkArray(node['links'], path + '.links', ledger, findings);
      }
    });
  }

  /* --- The two UNDATED bulleted sections ----------------------------- */

  /* Separate from the loop above because they take `checkUndatedNode`, and that
     difference is a contract decision rather than an accident - see that
     function's note. Walked in the field order `MasterProfile` declares, which
     is also the order `collectNodeIds` uses, so a reader comparing the two
     walks can do it line by line. */
  const undatedSections: readonly 'achievements'[] | readonly ('achievements' | 'certifications')[] =
    ['achievements', 'certifications'];

  for (const key of undatedSections) {
    const value = raw[key];
    if (!Array.isArray(value)) {
      findings.push({
        severity: 'blocking',
        path: key,
        problem: 'Missing or not an array. Use an empty array if there are none.',
      });
      counts[key] = 0;
      continue;
    }
    counts[key] = value.length;
    value.forEach((node, index) => {
      bulletCount += checkUndatedNode(node, key + '[' + String(index) + ']', ledger, findings);
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

  /* A DIFFERENT array from `identity.links` in the contract - both exist, both
     carry ids, and omitting either leaves a real collision undetectable. Now
     walked by the same function as the other two, so all three get the same
     label and url checks rather than the three-way drift described there. */
  const topLevelLinkCount = checkLinkArray(raw['links'], 'links', ledger, findings);

  /* --- Verdict -------------------------------------------------------- */

  /* Ledger findings come last so that field-level problems within a node are
     reported next to the node, and id collisions read as a group. */
  const structural = [...findings, ...ledger.collected()];
  const structuralBlocking = structural.filter((finding) => finding.severity === 'blocking');

  /* THE SEAM. Uniqueness runs only once the shape is proven, and this early
     return is what proves it.
     `findDuplicateNodeIds` walks a typed `MasterProfile` with no guards -
     `profile.identity.links`, `profile.skills`, `profile.achievements` and the
     rest, each dereferenced directly - so calling it on a malformed paste would
     throw a TypeError and lose the operator's paste, which this module's header
     forbids. Every one of those fields has just been checked above, and that is
     not incidental: the two walks have to stay in step, and the day a new node
     kind is added to `collectNodeIds` without being added to this file's walk,
     THIS is the line that turns into a crash. Adding the kind above is what
     keeps it a check. */
  if (structuralBlocking.length > 0) {
    return { ok: false, findings: structural };
  }

  /* Shape is sound, so the profile can be handed to the package's rule. The
     cast is the same one the success branch makes below, and it is earned by
     the same checks. */
  const shaped = raw as unknown as MasterProfile;
  const duplicates = duplicateFindings(shaped);

  const all = [...structural, ...duplicates];

  if (duplicates.length > 0) {
    /* Deliberately does NOT return a profile, exactly like the structural
       failure above: the union is what makes storing a rejected profile
       impossible rather than merely discouraged. */
    return { ok: false, findings: all };
  }

  return {
    ok: true,
    /* Advisory findings survive onto a successful ingest - they are things to
       improve, not reasons to refuse. */
    findings: all,
    /* Narrowed above rather than cast here, so there is ONE cast in this
       function and it sits immediately after the checks that earn it. */
    profile: shaped,
    summary: {
      skills: skillCount,
      experience: counts['experience'] ?? 0,
      projects: counts['projects'] ?? 0,
      education: counts['education'] ?? 0,
      achievements: counts['achievements'] ?? 0,
      certifications: counts['certifications'] ?? 0,
      bullets: bulletCount,
      /* All three link arrays summed. A per-array breakdown would invite the
         operator to reconcile three numbers against a resume that shows links
         in one place. */
      links: identityLinkCount + projectLinkCount + topLevelLinkCount,
      hasSummary,
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
