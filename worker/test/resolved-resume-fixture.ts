// A valid `ResolvedResume` for the worker's tests, and the fix for a real defect.
//
// WHAT WENT WRONG HERE, because the mechanism matters more than the fix. The
// previous fixture lived inline in render-resume-pdf.test.ts and was written in
// a shape that has never existed — `fullName`, `contact`, `skillGroups` — then
// forced past the compiler with `as unknown as Parameters<...>[0]['resume']`.
// So all three tests in that file failed at runtime with
//
//   ResumeRenderError: Unsupported resume schema_version undefined
//
// while `tsc --noEmit` and the workspace build both exited 0. THE CAST IS WHAT
// DID IT: `as unknown as` deletes exactly the check that would have caught the
// drift, so the fixture was free to describe a contract that no longer matched
// while every static signal stayed green. A cast in a fixture is not a
// convenience; it is an opt-out from the only mechanism keeping the fixture
// honest. `satisfies` below is the opposite choice — drift becomes a compile
// error, which is the discipline @applyy/resume-template's own fixture states in
// its header and the worker's copy had quietly abandoned.
//
// It is also why "typecheck passes" and "build passes" were reported as evidence
// that the renderer worked. Neither says anything about behaviour. Unmeasured is
// not the same as passing.
//
// SYNTHETIC CONTENT, DELIBERATELY. `master resume.pdf` in the repository root is
// Teja's real personal data and is not test material; nor is the identity in the
// template package's own fixture. Everything below is invented, so a fixture can
// never be mistaken for a document worth sending.
import type { ResolvedResume } from '@applyy/shared-types';

/**
 * The smallest resume that still exercises every section the renderer draws.
 *
 * `satisfies` rather than a type annotation: it checks the shape against the real
 * contract while keeping the literal types, so a test can assert on exact strings
 * without a cast — which is the failure this file exists to remove.
 */
export const syntheticResume = {
  // Must equal the renderer's SUPPORTED_SCHEMA_VERSION. The `undefined` this
  // field used to hold is the entire cause of the three failures above, and the
  // renderer refusing it was the guard working exactly as designed.
  schema_version: 1,
  // The pinned master version this selection was resolved against. Immutable, so
  // this fixture stays renderable after the master moves on.
  master_version: 1,
  // Identity is copied verbatim from the master and never tailored; the type
  // gives the Tailor no way to reach it.
  identity: {
    full_name: 'Ada Placeholder',
    headline: 'Backend Engineer',
    email: 'ada.placeholder@example.com',
    phone: '+91 90000 00000',
    location: 'Hyderabad, India',
    // Ordering is data: links print in the order the master declares them, so a
    // renderer that sorted them would break the approval guarantee silently.
    links: [{ id: 'lnk_github', label: 'GitHub', url: 'https://github.com/example' }],
  },
  // A tailoring decision carried as data. Skills first here so the PDF's text
  // layer is asserted against a non-default order — a renderer that recovered
  // section order by sorting would pass a fixture that used the natural order.
  section_order: ['skills', 'experience', 'projects', 'education'],
  // Null rather than a string: prose is the weakest point in the honesty model
  // and the null branch is the one the real pipeline takes most often.
  summary: null,
  skills: [
    // 'Node.js' is asserted in the PDF's extracted text, so it is load-bearing
    // for the §17.2 machine-readability check and must not be renamed casually.
    { ref: 'skl_node', name: 'Node.js', category: 'Languages & Runtimes' },
    { ref: 'skl_express', name: 'Express', category: 'Frameworks' },
  ],
  experience: [
    {
      ref: 'exp_one',
      company: 'Example Systems',
      role: 'Backend Developer',
      location: 'Hyderabad, India',
      // PRE-FORMATTED display strings. The renderer does no date arithmetic, so
      // output cannot vary with host timezone or ICU build — which is what makes
      // the determinism test meaningful rather than lucky.
      start_display: 'Jan 2025',
      end_display: 'Apr 2025',
      bullets: [
        {
          ref: 'bul_api',
          text: 'Designed and shipped a production REST API in Node.js/Express serving 500+ users',
          // The master wording, kept for the approval diff view. Never printed,
          // so it is present here to prove the renderer does not print it.
          master_text: 'Built a REST API with Express and Node.js',
        },
      ],
    },
  ],
  projects: [
    {
      ref: 'prj_one',
      name: 'Example project',
      url: 'https://example.com/project',
      start_display: 'Sep 2026',
      // Arrives as a display value from upstream; computing it would need a
      // clock, and a clock in the renderer is a determinism leak.
      end_display: 'Present',
      bullets: [
        {
          ref: 'bul_project',
          text: 'Built a queue-backed pipeline with a human approval gate',
          master_text: 'Built a pipeline with an approval step',
        },
      ],
    },
  ],
  education: [
    {
      ref: 'edu_one',
      institution: 'Example Institute of Technology',
      degree: 'B.Tech',
      field: 'Computer Science and Engineering',
      start_display: '2022',
      end_display: '2026',
      grade_display: 'CGPA 8.4 / 10',
      // Empty: coursework rarely earns its space against real projects, and the
      // empty-bullets branch is worth rendering at least once.
      bullets: [],
    },
  ],
} satisfies ResolvedResume;
