# @applyy/resume-template

_Last verified against code: 2026-11-08 (2a9ac31)._

The single HTML resume renderer. The web app imports it to draw the approval
preview Teja looks at. The Playwright worker imports the **same** function to
produce the PDF that gets submitted. That shared import is what makes *"what you
approved is byte-for-byte what gets sent"* a property of the code rather than a
promise (`PROJECT_PLAN.md` section 7).

```ts
import { renderResumeHtml } from '@applyy/resume-template';

const html = renderResumeHtml(resolvedResume); // complete, self-contained HTML document
```

Since 2026-11-07 the renderer also enforces part of the **one-page rule**: it
picks the typography that makes the resume fit one A4 page. See
[The one-page rule](#the-one-page-rule).

## What it exports

Everything comes from `src/index.ts`. Import from `@applyy/resume-template`, never
from a deep path. (Code outside the pnpm workspace links, such as the Deno tailor
and the web app, imports `packages/resume-template/src/index.ts` by relative path.
That is the same file.)

| Export | File | What it is for |
|---|---|---|
| `renderResumeHtml(resume)` | `src/render-resume-html.ts` | The renderer. Returns a full HTML document at the widest typography step that fits one page |
| `ResumeRenderError` | `src/render-resume-html.ts` | Thrown for a contract violation, for example an unsupported `schema_version` |
| `fitsOnePage(resume)` | `src/render-resume-html.ts` | The one-page question: does this resume fit at the readable minimum? |
| `TYPOGRAPHY_LADDER` | `src/page-fit.ts` | The typography rungs, widest first |
| `pickStepIndex`, `flowOf`, `flowFits`, `articleOf`, `stepStylesheet` | `src/page-fit.ts` | The page-fit model, exported so callers and the calibration test can measure every rung |
| `RESUME_STYLESHEET` | `src/print-styles.ts` | The base stylesheet (step 0), for tooling such as the diff view |
| `escapeHtml`, `safeHref` | `src/escape-html.ts` | The repo's one HTML escaper and link allow-list |

Who calls it (regenerate with
`git grep -n "resume-template" -- apps worker supabase ':!*.md'`):

| Caller | File | Uses |
|---|---|---|
| Web approval preview | `apps/web/src/features/resume-preview/renderPreview.ts` | `renderResumeHtml`, then reads the picked rung |
| Web edit gate | `apps/web/src/features/approval/pageFitEdit.ts` | `fitToOnePage` from the tailor's trimmer, which calls `fitsOnePage` |
| Tailor (Deno edge function) | `supabase/functions/_shared/tailor/page-trim.ts:27` | `fitsOnePage` |
| Worker PDF | `worker/src/render-resume-pdf.ts` | `renderResumeHtml` |
| Worker page-count CLI | `worker/src/cli/resume-pages.ts` | `renderResumeHtml`, `fitsOnePage`, `pickStepIndex` |

## The contract

`renderResumeHtml(resume: ResolvedResume): string` is **pure and deterministic**.

- No `fetch`, no filesystem, no environment, no globals.
- No `Date`, no `Intl`, no `toLocale*`, no `Math.random`, no `.sort()`.
- Identical input produces a byte-identical string on Teja's Windows machine and
  on the Ubuntu GitHub Actions runner.

This is not stylistic. The approval guarantee and the `tailored_hash` cache key
(constraint #8) both collapse without it. A hash that varies by host silently
defeats the cache. A hash that varies by run means the approved preview and the
submitted PDF are not provably the same document. A test asserts the absence of
those constructs **in the renderer source**, because a timezone bug only shows up
on a machine in another timezone. That is exactly the Windows-preview /
Ubuntu-runner split this system has.

The page-fit model keeps this contract. It is plain arithmetic over fixed width
tables, with numbers printed by `toFixed(2)`, so the CSS a step adds is the same
text on every machine.

It takes a `ResolvedResume` (owned by `@applyy/shared-types`), which carries no
master profile and no raw dates. The renderer therefore *cannot* resolve a node
ref or format a date even by accident. Both capabilities were removed from the
type rather than merely avoided in the code.

The renderer imports `shared-types` by **relative path**
(`src/render-resume-html.ts:49`), not by the bare package name. Reason: the Deno
tailor imports this renderer, and `supabase/functions/deno.json` has no import-map
entry for `@applyy/shared-types`. A relative path resolves the same file in Node,
Deno and Vite with no import-map change.

Line endings are normalised to LF in one place, at the end of `renderResumeHtml`,
and the package `.gitattributes` pins LF. Both exist because a CRLF checkout on
Windows would otherwise change the rendered bytes.

## The one-page rule

**The rule** (Teja, 2026-11-07): the tailored resume, and every resume after an
edit, must fit on **one page**. His ruling on *how*: shrink the typography first,
within a readable minimum, and only then remove content.

The rule is enforced in three places. Each owns one part:

| Step | Owner | What it does |
|---|---|---|
| 1. Shrink the type | This package, inside `renderResumeHtml` | Picks the widest typography rung that fits (`src/render-resume-html.ts:520`) |
| 2. Remove content | `supabase/functions/_shared/tailor/page-trim.ts` (`fitToOnePage`) | Runs only when even the minimum rung overflows. Called by the tailor and by the web edit gate |
| 3. Refuse to send | `worker/src/render-resume-pdf.ts:109` | Counts the real PDF pages and throws `ResumeNotOnePageError` if the count is not 1 |

### Why the step is picked inside the renderer

The web preview, the web Download PDF and the worker's submitted PDF all call
`renderResumeHtml`. Picking the step there means all three get the same step by
construction. There is no stored "scale" field that could disagree between the
preview and the PDF, and an edit re-picks the step automatically.

### The typography ladder

`TYPOGRAPHY_LADDER` in `src/page-fit.ts`, widest first. `pickStepIndex` returns
the first rung where the model says the resume fits. If none fits, it returns the
last rung, and the resume still renders there.

| Rung | Body font | Line height | Gap scale | Page margin | Summary margin | Note |
|---|---|---|---|---|---|---|
| 0 | 10.5pt (scale 1) | 1.38 | 1 | 14mm | 1em | The base stylesheet, unchanged |
| 1 | 10.5pt (scale 1) | 1.3 | 0.8 | 12mm | 1em | Less leading and gaps first |
| 2 | 10pt (scale 0.952) | 1.28 | 0.7 | 11mm | 1em | Half a point off the type |
| 3 | 9.5pt (scale 0.905) | 1.25 | 0.6 | 10mm | 1em | The minimum until 2026-11-08 |
| 4 | 9.5pt (scale 0.905) | 1.18 | 0.4 | 8mm | 0.5em | Dense (added in `dc8ac5c`) |
| 5 | 9.5pt (scale 0.905) | 1.15 | 0.3 | 7mm | 0.3em | **The readable minimum** (added in `dc8ac5c`) |

Rules the ladder keeps:

- **Rung 0 adds no CSS.** `stepStylesheet(0)` returns an empty string, so a
  resume that already fits renders byte-identical to the output from before the
  ladder existed. The golden-file test proves it.
- **The body font never goes below 9.5pt.** Below that a printed resume reads as
  small print. A page margin under about 7mm reaches the unprintable edge of
  ordinary printers.
- **Why rungs 4 and 5 exist (`dc8ac5c`, 2026-11-08).** Two live rows were 12-19%
  over one page at rung 3 with every content floor already reached. The rule is
  layout before content, and the font may not shrink further. So the dense rungs
  tighten only leading, gaps, margins and the summary's paragraph margin.
- **No multi-column skills**, even to save space. A column is exactly what this
  template forbids for ATS reading order (see [ATS parsing](#ats-parsing-172--the-rules-the-layout-is-bound-by)).
- **Rungs 0-3 render the same bytes as before `dc8ac5c`.** The new
  `paragraphEm` field is 1 on those rungs, and `stepStylesheet` adds the summary
  rule only when it is not 1.

The web preview shows the hint "Fitted to one page (smaller type)" only when the
picked rung has `fontScale < 1` (`apps/web/src/features/resume-preview/renderPreview.ts:65`,
added in `2936e8c`). Spacing-only rungs do not trigger it.

### `fitsOnePage`: the question the trimmer asks

`fitsOnePage(resume)` renders the resume and measures it at the **last** rung.

- `true`: `renderResumeHtml` prints it on one page, at the widest rung that fits.
- `false`: content must go. The tailor trims; the web edit gate refuses or trims.
- It **fails closed**. A resume the renderer refuses (for example a stale
  `schema_version`) answers `false`, because "cannot measure" is not "fits".

### Why a model and not a browser

The ground truth is Chromium's print layout. But this package runs in three
runtimes, and two of them (the Deno tailor and Node tests) cannot lay out HTML.
So `src/page-fit.ts` **estimates** the height from the exact markup the renderer
emits:

- Character widths are tables measured in Chromium, taking the **maximum** of
  Georgia and Times New Roman (upright and italic). Liberation Serif matches
  Times New Roman, so one table is safe on Windows and on the Linux worker.
- An unknown character counts as a full em. Word wrap breaks at spaces only.
  Both choices can only make the estimate longer.
- A `SAFETY` factor of 0.97 keeps headroom below the page bottom.

The model may be pessimistic (it shrinks or trims a little early). It must never
be optimistic, because that would print a second page. This is held to the real
renderer by `worker/test/page-fit-calibration.test.ts`, which renders resumes in
real Chromium under both fonts at every rung and asserts "the model says it fits"
implies "the real PDF is one page".

If you change `src/print-styles.ts`, change the `STYLE` table and the
`stepStylesheet` overrides in `src/page-fit.ts` too, then run the calibration
test.

### The trim order (content side, not in this package)

The trimmer lives in `supabase/functions/_shared/tailor/page-trim.ts`. It is
summarised here because it is the second half of the same rule. Read the file for
the authority.

- **Order** (`TRIM_ORDER`): `certification`, then `project_bullet_over_cap`, then
  `weakest_bullet`. One item is removed at a time, and the fit is measured again
  after each removal.
  - Teja's ruling on 2026-11-07 23:00 IST was bullets first. At 23:55 IST he
    changed it to certifications first. Rows tailored between the two rulings were
    trimmed in the old order.
- **Floors** (`PAGE_FIT_FLOORS`): at least 2 certification entries; per-entry
  bullet minimums by section (experience 1, projects 3, achievements 1), with
  per-ref overrides; projects above 4 bullets are trimmed first. Change a floor
  in that file and nowhere else.
- **Never removed:** skills, the summary and education.
- **Removal only, never shortening.** A removed bullet is still true. A shortened
  one may not be.
- "Weakest" means fewest job-description keywords (`keywordAppearsIn`), then the
  later position.
- If the floors themselves do not fit, the result is `fits: false` and the caller
  refuses. Nothing is trimmed below a floor.

## For the worker: `page.pdf()`

`worker/src/render-resume-pdf.ts` sets the HTML and prints it like this (see
lines 55-71 for the full comments):

```ts
await page.setContent(html, { waitUntil: 'domcontentloaded' });
const bytes = await page.pdf({
  format: 'A4',
  margin: { top: '0', right: '0', bottom: '0', left: '0' },
  printBackground: true,
  displayHeaderFooter: false,
});
```

The stylesheet declares `@page { size: A4; margin: 14mm }` (`src/print-styles.ts:33`),
and a non-zero rung overrides that margin. Playwright adds no margin of its own,
so the stylesheet's margin is the only one. Then the worker counts the pages with
pdf.js and refuses anything but one page (`ResumeNotOnePageError`). That refusal
covers every path that attaches a PDF, so no path can send a two-page resume.

No network access is needed or attempted: the stylesheet is inlined, there are no
web fonts, no `<img>`, no `<link>`, no `@import`. Asserted by test.

To see the real page count of stored resumes, use the read-only CLI
`worker/src/cli/resume-pages.ts`. Its header comment has the exact commands.

## For the web app: the preview, and escaping

The preview renders the **same string** in an iframe `srcdoc`
(`apps/web/src/features/resume-preview/ResumePreview.tsx`), so the preview and the
PDF are the same bytes rather than two renders believed to agree. "Download PDF"
prints the frame's own window, so it prints that same document
(`apps/web/src/features/resume-preview/ResumePreview.tsx:170`).

Do not rebuild the resume out of React components. A second renderer is a second
thing to keep in sync, and drift there breaks the approval guarantee silently.

This package also exports the repo's escaping helpers. **Import these rather than
writing another one.** Two escapers in one repo is how one of them ends up subtly
wrong and nobody notices:

```ts
import { escapeHtml, safeHref } from '@applyy/resume-template';
```

`escapeHtml` escapes `& < > " '`, ampersand first (otherwise it re-escapes its own
output). `safeHref` **allow-lists** `http:`, `https:` and `mailto:` and collapses
anything else to `#`. Quote-escaping alone does not stop `javascript:`, and the
approval preview is precisely where a human clicks a link derived from untrusted
input (constraint #17).

## ATS parsing (§17.2) — the rules the layout is bound by

The most common silent killer of a fresher's resume is a nicely designed
two-column layout that a text extractor parses into interleaved gibberish. The
machine never sees the skills, and a human never sees the resume. **Parser first,
eye second.** Accordingly:

- `column-count: 1`, no multi-column shorthand, no floats, no absolute
  positioning, no layout tables. All asserted by test.
- Achievement lines are real `<ul>/<li>`. Extractors emit list items as separate
  lines, while a div-with-a-dash collapses into one run-on paragraph.
- Exactly one `<h1>` (the candidate name). Parsers weight the first heading as the
  name, and competing `<h1>`s confuse them.
- Conventional section headings (`Experience`, `Skills`, ...). A clever heading is
  a heading the parser does not recognise, so its content is filed as
  unclassified prose.
- The contact separator is a real `•` character in the markup, not CSS generated
  content. Generated content is invisible to extractors, which would otherwise run
  `email` and `phone` together into one token.

`test/ats-parse.test.ts` checks these with a naive text extractor
(`test/naive-text-extract.ts`). Send any parse-simulator failure back here as a
new fixture test.

## Tests

From `packages/resume-template/`:

```bash
node --test "test/**/*.test.ts"
```

Or from the repo root:

```bash
pnpm --filter @applyy/resume-template test
pnpm --filter @applyy/resume-template typecheck
```

Read `tests`, `fail` and `cancelled` from the run, not from a doc. As of
2026-11-08 the run reports `fail 0` and `cancelled 0`. `tests 0` with `fail 0`
means the glob matched nothing.

| Test file | What it pins |
|---|---|
| `test/render-resume-html.test.ts` | The golden render, purity bans in the source, escaping, the honesty gate |
| `test/ats-parse.test.ts` | The ATS layout rules above |
| `test/page-fit.test.ts` | Rung 0 unchanged, the 9.5pt floor, and that a resume as far over as the two live rows now fits |
| `worker/test/page-fit-calibration.test.ts` (in the worker) | The model against real Chromium, both fonts, every rung |

`node:test` ships with Node 24 and runs `.ts` directly via native type stripping,
so the package drags no build-time test dependency behind it.

The suite renders section 11's worked example (Backend Intern @ Zomato) and
compares it against a committed golden file,
`test/fixtures/zomato-backend-intern.golden.html`. A golden **file** rather than a
bare hash, so a failure shows *what* changed in the resume. To accept an intended
change:

```bash
UPDATE_GOLDEN=1 pnpm --filter @applyy/resume-template test
```

Regeneration is opt-in, so a normal run can never silently rewrite the golden and
make a real regression disappear. Review the diff: that file is what gets sent to
employers.

The honesty-gate tests assert that section 11's fabricated skills (`PostgreSQL`,
`Docker`) **cannot** appear, and that every rendered bullet carries a `data-ref`
back to a master node.

### Cross-runtime check

```bash
node                                        test/cross-runtime-hash.ts
deno run --allow-read=. --config deno.json  test/cross-runtime-hash.ts
```

Both must print the same SHA-256 and byte count. A single test process cannot
check this, because a test process is one runtime. That is why it is a script and
not an assertion. Do not compare against a hash written in a doc: the golden
fixture changes whenever the template does.

## No build step

`package.json` `exports` points at `./src/index.ts`. The section 20 step 0 spike
proved all three runtimes consume the source directly: Node 22.18 and later strip
types natively (pnpm workspace symlinks resolve to a realpath *outside*
`node_modules`, so Node's "no type stripping in node_modules" rule does not fire),
Deno reads `.ts`, and Vite transpiles. A `dist/` build would only create a second
copy of the renderer that could go stale, and a stale renderer is exactly what the
approval guarantee cannot tolerate.

Requirements this imposes, locked in `tsconfig.base.json`: pure ESM, explicit
`.ts` extensions on relative imports, and erasable-syntax-only TypeScript (no
`enum`, no `namespace`, no constructor parameter properties; Deno accepts them,
Node v24 throws at parse).

**The old edge-function deploy risk is closed.** This README used to say it was
unproven that `supabase functions deploy` could bundle a file outside
`supabase/functions/`. The tailor now imports this package by relative path
(`supabase/functions/_shared/tailor/page-trim.ts:27`), and the tailor was deployed
with that import on 2026-11-08 at `7a78d05` or later
(`docs/handoff/2026-11-08-0045-orchestrator-handoff.md`, the deploy table). If a future deploy ever fails to bundle it, the measured
fallback is `deno bundle` of `packages/resume-template/src/index.ts` into a
single file under `supabase/functions/_shared/`.

## Known limitation, stated honestly

The byte-for-byte guarantee is on the **HTML**. The PDF is laid out by the
worker's Chromium, so if the preview renders in Teja's browser on Windows and the
PDF renders on Ubuntu, *glyph metrics can differ* and line breaks may not land
identically. Two things limit the damage:

- The page-fit width tables take the wider of Georgia and Times New Roman, so the
  one-page decision is safe under either font.
- The worker counts the real PDF pages and refuses a second page.

So a font difference can move a line break, but it cannot send a two-page resume.
If exact visual fidelity is ever required, the honest fix is to show Teja the
**PDF the worker produced**, not an HTML preview of it.
