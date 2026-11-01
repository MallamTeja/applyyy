/* Synthetic master profiles for the reconciler tests.
 *
 * EVERY VALUE HERE IS INVENTED. The real resume carries a legal name, email and
 * phone number, and it is deliberately NOT copied into this repository. What is
 * copied is the SHAPE, measured from the real document on 2026-09-10, because a
 * fixture with the wrong shape produces tests that pass against a profile
 * nothing could actually produce:
 *
 *   - experience entries are written "Role - Company" with a date range, so
 *     company and role are separate strings;
 *   - one project has a name plus a rewordable tagline separated by an en dash,
 *     the other has a bare name;
 *   - skills are grouped under categories;
 *   - education is a table of (degree, institution, duration) rows;
 *   - bullets are one long justified line each, which is why the real document
 *     hyphenates across line breaks.
 *
 * Typed against the real `MasterProfile` from shared-types, so a fixture that
 * stops matching the contract becomes a COMPILE error rather than a green test.
 */

import type {
  MasterAchievement,
  MasterBullet,
  MasterCertification,
  MasterEducation,
  MasterExperience,
  MasterLink,
  MasterProfile,
  MasterProject,
  MasterSkill,
  MasterSummary,
  NodeId,
} from '@applyy/shared-types';

/* A counter-based id minter. Deterministic and inspectable, which is the whole
 * reason `mintId` is injected rather than reading `crypto.randomUUID` - a test
 * can assert on the exact ids that were minted instead of on how many. */
export function makeMinter(prefix: string): () => NodeId {
  let next = 0;
  return () => {
    next += 1;
    return prefix + '-' + String(next);
  };
}

/* A bullet. Tags are required by the contract, so they are always present. */
export function bullet(id: string, text: string, tags: readonly string[] = ['tag']): MasterBullet {
  return { id, text, tags };
}

export function skill(id: string, name: string, category: string): MasterSkill {
  return { id, name, category };
}

export function link(id: string, label: string, url: string): MasterLink {
  return { id, label, url };
}

export function experience(
  id: string,
  company: string,
  role: string,
  bullets: readonly MasterBullet[],
  startDisplay = 'May 2026',
): MasterExperience {
  return {
    id,
    company,
    role,
    location: 'Hyderabad, IN',
    start_display: startDisplay,
    /* "Present" is a literal display string: the renderer performs no date
       maths at all, so nothing downstream could compute it. */
    end_display: 'Present',
    start_date: null,
    end_date: null,
    bullets,
  };
}

/* The summary node. An id, never a bare string - that id is what
   `TailoredSummary.refs` points at. */
export function summary(id: string, text: string): MasterSummary {
  return { id, text };
}

/* An achievement. `description` defaults to null and `bullets` to empty, because
   that is the shape of most real achievement lines - a single undated string. A
   test that needs the bulleted form passes them explicitly, so the default cannot
   quietly make every fixture exercise the nested case. */
export function achievement(
  id: string,
  label: string,
  description: string | null = null,
  bullets: readonly MasterBullet[] = [],
  /* Credential/profile links, added to the contract 2026-11-01. OMITTED BY
     DEFAULT, not defaulted to [] - every stored master v1-v8 has no `links` key
     on its achievements, so the default fixture must stay in that shape or no
     test would ever exercise the absent-key read path the readers must survive. */
  links?: readonly MasterLink[],
): MasterAchievement {
  /* Absent links -> no key at all (the v1-v8 shape); present -> the key. */
  return links === undefined ? { id, label, description, bullets } : { id, label, description, bullets, links };
}

/* A certification. Structurally identical to `achievement` and written out
   separately anyway: they are distinct types with distinct match keys, and a
   shared builder returning a cast would let a certification fixture silently
   satisfy an achievement assertion. */
export function certification(
  id: string,
  label: string,
  description: string | null = null,
  bullets: readonly MasterBullet[] = [],
  /* Credential links. Omitted by default for the same reason as `achievement`:
     the stored v1-v8 shape has no key, and that shape must stay the common one. */
  links?: readonly MasterLink[],
): MasterCertification {
  /* Absent links -> no key at all (the v1-v8 shape); present -> the key. */
  return links === undefined ? { id, label, description, bullets } : { id, label, description, bullets, links };
}

export function project(
  id: string,
  name: string,
  bullets: readonly MasterBullet[],
  /* Defaults to ONE link, which is the common case in the real document. The
     two-link project - the case that motivated replacing `url: string | null` -
     passes both explicitly, so the default must not silently make every project
     look like the multi-link one and hide whether the walk handles it. */
  links: readonly MasterLink[] = [link(id + '-live', 'Live', 'https://example.invalid/' + id)],
): MasterProject {
  return {
    id,
    name,
    links,
    start_display: 'Jan 2026',
    end_display: 'Present',
    start_date: null,
    end_date: null,
    bullets,
  };
}

export function education(
  id: string,
  institution: string,
  degree: string,
  bullets: readonly MasterBullet[] = [],
): MasterEducation {
  return {
    id,
    institution,
    degree,
    field: null,
    start_display: '2024',
    end_display: '2027',
    start_date: null,
    end_date: null,
    grade_display: '8.4 CGPA',
    bullets,
  };
}

/* Assembles a profile from its sections, filling identity with invented
 * values. Every section defaults to empty so a test can build the smallest
 * profile that exercises one thing - a large fixture makes a failure hard to
 * localise. */
export function profileOf(parts: {
  readonly identityLinks?: readonly MasterLink[];
  readonly summary?: MasterSummary | null;
  readonly skills?: readonly MasterSkill[];
  readonly experience?: readonly MasterExperience[];
  readonly projects?: readonly MasterProject[];
  readonly education?: readonly MasterEducation[];
  readonly achievements?: readonly MasterAchievement[];
  readonly certifications?: readonly MasterCertification[];
  readonly links?: readonly MasterLink[];
}): MasterProfile {
  return {
    schema_version: 1,
    identity: {
      full_name: 'Ada Placeholder',
      headline: 'Full Stack AI Engineer',
      email: 'ada@example.invalid',
      phone: null,
      location: 'Hyderabad, IN',
      links: parts.identityLinks ?? [],
    },
    /* Defaults to null - the ABSENT case, not an empty-text node. A default
       summary node would put an extra id into every fixture that never asked for
       one, and `collectNodeIds` counts are asserted exactly. */
    summary: parts.summary ?? null,
    education: parts.education ?? [],
    experience: parts.experience ?? [],
    projects: parts.projects ?? [],
    skills: parts.skills ?? [],
    achievements: parts.achievements ?? [],
    certifications: parts.certifications ?? [],
    links: parts.links ?? [],
  };
}

/* THE STORED PROFILE - stands in for version N, the one applications pin.
 *
 * Ids are readable rather than uuid-shaped, so an assertion failure names the
 * node it is about. Two employers, two projects (one with a tagline), four
 * skills across three categories, two education rows, two links. */
export const STORED: MasterProfile = profileOf({
  identityLinks: [link('lnk-github', 'GitHub', 'https://github.com/example')],
  /* A summary NODE, because that is the whole point of the 2026-09-11 contract
     change: the paragraph has an id, so `TailoredSummary.refs` can name it and the
     validator can resolve it like any other ref. */
  summary: summary('sum-headline', 'Full stack engineer shipping AI products end to end.'),
  skills: [
    skill('sk-python', 'Python', 'Programming'),
    skill('sk-sql', 'SQL', 'Programming'),
    /* C and C++ together on purpose: they are the pair that collapses onto one
       key if the match key ever strips punctuation. */
    skill('sk-c', 'C', 'Programming'),
    skill('sk-cpp', 'C++', 'Programming'),
    skill('sk-docker', 'Docker', 'Tools'),
  ],
  experience: [
    experience('exp-northwind', 'Northwind Systems', 'Full Stack AI Engineer', [
      bullet('b-nw-1', 'Integrated LLM APIs with RAG pipelines into the billing product.'),
      bullet('b-nw-2', 'Cut p95 latency 40% by adding a read-through cache.'),
      bullet('b-nw-3', 'Built AI agents for lead enrichment and customer engagement.'),
    ]),
    experience(
      'exp-helios',
      'Helios Analytics',
      'Technical Coordinator',
      [bullet('b-he-1', 'Organised two hackathons with 340 student attendees.')],
      'Nov 2024',
    ),
  ],
  projects: [
    /* Name plus a rewordable tagline, exactly like the real document. TWO LINKS -
       a live deployment and a source repository. This is the case that made
       `url: string | null` wrong: under the old contract one of these two was
       dropped on every upload, with nothing reporting it. */
    project(
      'prj-oneonone',
      'One-on-One - AI-Powered Learning Platform',
      [
        bullet('b-oo-1', 'Built a full-stack booking platform with paid sessions.'),
        bullet('b-oo-2', 'Developed backend services using PostgreSQL, Redis and JWT auth.'),
      ],
      [
        link('lnk-oo-live', 'Live', 'https://oneonone.example.invalid'),
        link('lnk-oo-repo', 'Source', 'https://github.com/example/oneonone'),
      ],
    ),
    /* One link, taking the builder's default: the single-address case still has to
       work, and a fixture where every project had two would not prove that. */
    project('prj-racepace', 'Race Pace Predictor', [
      bullet('b-rp-1', 'Trained gradient boosting models on qualifying telemetry.'),
    ]),
  ],
  education: [
    education('edu-mlr', 'Placeholder Institute of Technology', 'B.Tech (CSD)'),
    education('edu-tkr', 'Placeholder College of Engineering', 'Diploma (ECE)'),
  ],
  /* Three achievements, matching the count in the real document. One carries a
     bullet so the NESTED id under a new kind is exercised - an achievement's
     bullets are a fresh place for a walk to forget to descend into. */
  achievements: [
    achievement('ach-sih', 'Winner - Smart India Hackathon 2025', 'National finals, 312 teams', [
      bullet('b-ach-1', 'Led a team of six building an offline-first grievance tracker.'),
    ]),
    achievement('ach-gsoc', 'Top 5% - Google Summer of Code applicant pool', null),
    achievement('ach-rank', 'Department rank 2 of 180', 'B.Tech CSD, 2024-25'),
  ],
  /* Four certifications, matching the real document, each written "Name - Issuer"
     so `label` and `description` carry the two halves the parser actually sees. */
  certifications: [
    certification('cert-aws', 'AWS Certified Cloud Practitioner', 'Amazon Web Services'),
    certification('cert-ml', 'Machine Learning Specialization', 'DeepLearning.AI'),
    certification('cert-pg', 'PostgreSQL for Developers', 'EDB'),
    certification('cert-sec', 'Web Security Fundamentals', 'Portswigger'),
  ],
  links: [link('lnk-site', 'Portfolio', 'https://example.invalid')],
});

/* Re-parses a profile: identical CONTENT, throwaway ids.
 *
 * This is what a fresh PDF parse actually produces, and using it rather than
 * passing `STORED` back in is what makes the byte-identical test meaningful. If
 * a test fed the stored profile in as `incoming`, every id would already be
 * correct and the test would pass with the entire reconciler deleted - the
 * exact vacuous-expectation trap the repo's verification-traps document records
 * as instance 13.
 *
 * The placeholder ids are POSITIONAL (`p-bullet-0`, `p-bullet-1`, ...) on
 * purpose: that is how a naive parser labels nodes, and it means a reconciler
 * that lazily kept incoming ids would produce colliding, wrong-meaning ids
 * rather than obviously broken ones. */
export function reparse(source: MasterProfile): MasterProfile {
  /* One counter per kind, restarting from zero, so the placeholder ids look
     exactly like a parser's output and carry no information from `source`. */
  let bulletCount = 0;
  const nextBulletId = (): string => {
    const id = 'p-bullet-' + String(bulletCount);
    bulletCount += 1;
    return id;
  };
  const reparseBullets = (bullets: readonly MasterBullet[]): readonly MasterBullet[] =>
    bullets.map((b) => ({ ...b, id: nextBulletId() }));

  /* Project links get their own positional counter, spanning ALL projects rather
     than restarting per project - a parser numbering anchors as it walks the page
     has no idea which project it is inside. Restarting per project would hand the
     reconciler ids that are already distinct in a way a real parse would not. */
  let projectLinkCount = 0;
  const reparseProjectLinks = (links: readonly MasterLink[]): readonly MasterLink[] =>
    links.map((l) => {
      const id = 'p-plink-' + String(projectLinkCount);
      projectLinkCount += 1;
      return { ...l, id };
    });

  /* Achievement and certification links (2026-11-01) get a THIRD positional
     counter spanning both sections, for the same reason project links span all
     projects: a parser numbering anchors down the page does not know which entry
     it is under. Without this, `...c` would keep the STORED link ids and every
     carry assertion on them would pass with the link reconciliation deleted. */
  let entryLinkCount = 0;
  const reparseEntryLinks = <T extends { readonly links?: readonly MasterLink[] }>(node: T): T => {
    /* An absent key stays absent, so a v1-v8-shaped source reparses v1-v8-shaped. */
    if (node.links === undefined) return node;
    /* Present: re-identify every link positionally. */
    return {
      ...node,
      links: node.links.map((l) => {
        const id = 'p-elink-' + String(entryLinkCount);
        entryLinkCount += 1;
        return { ...l, id };
      }),
    };
  };

  return {
    schema_version: 1,
    identity: {
      ...source.identity,
      links: source.identity.links.map((l, i) => ({ ...l, id: 'p-ilink-' + String(i) })),
    },
    /* The summary is re-identified too. Left alone it would keep its STORED id and
       every summary-carry assertion would pass with the summary reconciler deleted -
       instance 13's vacuous expectation, reintroduced in a new field. */
    summary: source.summary === null ? null : { ...source.summary, id: 'p-summary-0' },
    skills: source.skills.map((s, i) => ({ ...s, id: 'p-skill-' + String(i) })),
    experience: source.experience.map((e, i) => ({
      ...e,
      id: 'p-exp-' + String(i),
      bullets: reparseBullets(e.bullets),
    })),
    projects: source.projects.map((p, i) => ({
      ...p,
      id: 'p-prj-' + String(i),
      links: reparseProjectLinks(p.links),
      bullets: reparseBullets(p.bullets),
    })),
    education: source.education.map((e, i) => ({
      ...e,
      id: 'p-edu-' + String(i),
      bullets: reparseBullets(e.bullets),
    })),
    /* Achievement and certification bullets share the ONE bullet counter with every
       other section, because a parser labelling bullets positionally down the page
       does not restart at each heading. That shared counter is also what makes a
       cross-kind id collision expressible in a reparse at all. */
    achievements: source.achievements.map((a, i) => ({
      ...reparseEntryLinks(a),
      id: 'p-ach-' + String(i),
      bullets: reparseBullets(a.bullets),
    })),
    certifications: source.certifications.map((c, i) => ({
      ...reparseEntryLinks(c),
      id: 'p-cert-' + String(i),
      bullets: reparseBullets(c.bullets),
    })),
    links: source.links.map((l, i) => ({ ...l, id: 'p-link-' + String(i) })),
  };
}
