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
  MasterBullet,
  MasterEducation,
  MasterExperience,
  MasterLink,
  MasterProfile,
  MasterProject,
  MasterSkill,
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

export function project(
  id: string,
  name: string,
  bullets: readonly MasterBullet[],
): MasterProject {
  return {
    id,
    name,
    url: 'https://example.invalid/' + id,
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
  readonly skills?: readonly MasterSkill[];
  readonly experience?: readonly MasterExperience[];
  readonly projects?: readonly MasterProject[];
  readonly education?: readonly MasterEducation[];
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
    education: parts.education ?? [],
    experience: parts.experience ?? [],
    projects: parts.projects ?? [],
    skills: parts.skills ?? [],
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
    /* Name plus a rewordable tagline, exactly like the real document. */
    project('prj-oneonone', 'One-on-One - AI-Powered Learning Platform', [
      bullet('b-oo-1', 'Built a full-stack booking platform with paid sessions.'),
      bullet('b-oo-2', 'Developed backend services using PostgreSQL, Redis and JWT auth.'),
    ]),
    project('prj-racepace', 'Race Pace Predictor', [
      bullet('b-rp-1', 'Trained gradient boosting models on qualifying telemetry.'),
    ]),
  ],
  education: [
    education('edu-mlr', 'Placeholder Institute of Technology', 'B.Tech (CSD)'),
    education('edu-tkr', 'Placeholder College of Engineering', 'Diploma (ECE)'),
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

  return {
    schema_version: 1,
    identity: {
      ...source.identity,
      links: source.identity.links.map((l, i) => ({ ...l, id: 'p-ilink-' + String(i) })),
    },
    skills: source.skills.map((s, i) => ({ ...s, id: 'p-skill-' + String(i) })),
    experience: source.experience.map((e, i) => ({
      ...e,
      id: 'p-exp-' + String(i),
      bullets: reparseBullets(e.bullets),
    })),
    projects: source.projects.map((p, i) => ({
      ...p,
      id: 'p-prj-' + String(i),
      bullets: reparseBullets(p.bullets),
    })),
    education: source.education.map((e, i) => ({
      ...e,
      id: 'p-edu-' + String(i),
      bullets: reparseBullets(e.bullets),
    })),
    links: source.links.map((l, i) => ({ ...l, id: 'p-link-' + String(i) })),
  };
}
