# @applyy/resume-template

The single HTML resume renderer. React imports it to draw the approval preview
Teja looks at; the Playwright worker imports the **same** function to produce the
PDF that gets submitted. That shared import is what makes *"what you approved is
byte-for-byte what gets sent"* a property of the code rather than a promise
(PROJECT_PLAN §7).

```ts
import { renderResumeHtml } from '@applyy/resume-template';

const html = renderResumeHtml(resolvedResume); // complete, self-contained HTML document
```

## The contract

`renderResumeHtml(resume: ResolvedResume): string` is **pure and deterministic**.

- No `fetch`, no filesystem, no environment, no globals.
- No `Date`, no `Intl`, no `toLocale*`, no `Math.random`, no `.sort()`.
- Identical input produces a byte-identical string on Teja's Windows machine and
  on the Ubuntu GitHub Actions runner.

This is not stylistic. The approval guarantee and the `tailored_hash` cache key
(constraint #8) both collapse without it: a hash that varies by host silently
defeats the cache, and one that varies by run means the approved preview and the
submitted PDF are not provably the same document. A test asserts the absence of
those constructs **in the renderer source**, because a timezone bug only shows up
on a machine in another timezone — which is exactly the Windows-preview /
Ubuntu-runner split this system has.

It takes a `ResolvedResume` (owned by `@applyy/shared-types`), which carries no
master profile and no raw dates. The renderer therefore *cannot* resolve a node
ref or format a date even by accident — both capabilities were removed from the
type rather than merely avoided in the code.

## For the worker (applyy-21): `page.pdf()`

```ts
await page.setContent(renderResumeHtml(resume), { waitUntil: 'load' });
await page.pdf({ path: out, preferCSSPageSize: true, printBackground: false });
```

**`preferCSSPageSize: true` is required.** The stylesheet declares
`@page { size: A4; margin: 14mm }`. Without that flag Playwright silently ignores
the rule and uses its own default (Letter), cropping the bottom of every page on
A4 paper. `printBackground` can stay `false` — the design deliberately uses
borders rather than background fills, so nothing is lost.

No network access is needed or attempted: the stylesheet is inlined, there are no
web fonts, no `<img>`, no `<link>`, no `@import`. Asserted by test.

## For the web app (applyy-76): the preview, and escaping

Render the preview from the **same string**, in an iframe, so the preview and the
PDF are the same bytes rather than two renders believed to agree:

```tsx
<iframe srcDoc={renderResumeHtml(resume)} title="Resume preview" />
```

Do not rebuild the resume out of React components — a second renderer is a second
thing to keep in sync, and drift there breaks the approval guarantee silently.

This package also exports the repo's escaping helpers. **Import these rather than
writing another one** — two escapers in one repo is how one of them ends up
subtly wrong and nobody notices:

```ts
import { escapeHtml, safeHref } from '@applyy/resume-template';
```

`escapeHtml` escapes `& < > " '`, ampersand first (otherwise it re-escapes its own
output). `safeHref` **allow-lists** `http:`, `https:` and `mailto:` and collapses
anything else to `#` — quote-escaping alone does not stop `javascript:`, and the
approval preview is precisely where a human clicks a link derived from untrusted
input (constraint #17).

## ATS parsing (§17.2) — the rules the layout is bound by

The single most common silent fresher killer is a nicely designed two-column
resume that a text extractor parses into interleaved gibberish, so the machine
never sees the skills and a human never sees the resume. **Parser first, eye
second.** Accordingly:

- `column-count: 1`, no multi-column shorthand, no floats, no absolute
  positioning, no layout tables. All asserted by test.
- Achievement lines are real `<ul>/<li>` — extractors emit list items as separate
  lines, while a div-with-a-dash collapses into one run-on paragraph.
- Exactly one `<h1>` (the candidate name); parsers weight the first heading as the
  name and competing `<h1>`s confuse them.
- Conventional section headings (`Experience`, `Skills`, …). A clever heading is a
  heading the parser does not recognise, so its content is filed as unclassified
  prose.
- The contact separator is a real `•` character in the markup, not CSS generated
  content — generated content is invisible to extractors, which would otherwise
  run `email` and `phone` together into one token.

**applyy-21: send parse-simulator failures back here.** This is expected to be a
loop, and the fixture suite is where each finding should land as a regression test.

## Tests

```bash
pnpm --filter @applyy/resume-template test        # node --test, 19 tests, no framework
pnpm --filter @applyy/resume-template typecheck
```

`node:test` ships with Node 24 and runs `.ts` directly via native type stripping,
so the package that must stay importable by three runtimes drags no build-time
test dependency behind it.

The suite renders §11's worked example (Backend Intern @ Zomato) and compares it
against a committed golden file, `test/fixtures/zomato-backend-intern.golden.html`.
A golden **file** rather than a bare hash so a failure shows *what* changed in the
resume. To accept an intended change:

```bash
UPDATE_GOLDEN=1 pnpm --filter @applyy/resume-template test
```

Regeneration is opt-in so a normal run can never silently rewrite the golden and
make a real regression disappear. Review the diff — that file is what gets sent to
employers.

The honesty-gate tests assert that §11's fabricated skills (`PostgreSQL`,
`Docker`) **cannot** appear, and that every rendered bullet carries a `data-ref`
back to a master node.

### Cross-runtime check

```bash
node                                        test/cross-runtime-hash.ts
deno run --allow-read=. --config deno.json  test/cross-runtime-hash.ts
```

Both must print the same SHA-256. Verified: `525c5304…` / 11111 bytes on Node
v24.14.0 and Deno 2.9.6. A single test process cannot check this, because a test
process is one runtime — which is why it is a script and not an assertion.

## No build step, and the one open risk

`package.json` `exports` points at `./src/index.ts`. The §20 step 0 spike proved
all three runtimes consume the source directly: Node ≥22.18 strips types natively
(and pnpm workspace symlinks resolve to a realpath *outside* `node_modules`, so
Node's "no type stripping in node_modules" restriction does not fire), Deno reads
`.ts`, Vite transpiles. A `dist/` build would only create a second copy of the
renderer that could go stale — and a stale renderer is exactly what the approval
guarantee cannot tolerate.

Requirements this imposes, now locked in `tsconfig.base.json`: pure ESM, explicit
`.ts` extensions on relative imports, and erasable-syntax-only TypeScript (no
`enum`, no `namespace`, no constructor parameter properties — Deno accepts them,
Node v24 throws at parse).

**OPEN RISK — Supabase Edge Function deploy.** Local `deno run` with an import map
proves *resolution*. It does not prove that `supabase functions deploy` bundles a
file living outside `supabase/functions/`. There is no dry-run flag; closing this
needs a real deploy, which is gated on Teja's approval.

**Fallback if it fails** (already measured, so nobody has to rediscover it under
pressure): pre-bundle before deploying.

```bash
deno bundle --config supabase/functions/deno.json \
  -o supabase/functions/_shared/resume-template.js \
  packages/resume-template/src/index.ts
```

The whole graph collapsed to a single **723-byte** ESM file in **570 ms**. So the
worst case is one pre-deploy build step — not a monorepo layout change and not a
duplicated source of truth.

## Known limitation, stated honestly

The byte-for-byte guarantee is on the **HTML**. The PDF is rasterised by the
worker's Chromium, so if the approval preview renders in Teja's browser on
Windows and the PDF renders on Ubuntu, *glyph metrics can differ* and line breaks
may not land identically. The font stack is chosen to keep metrically-compatible
fallbacks (Georgia → Liberation Serif) and there are no web fonts to fail to load,
which makes a page-count difference unlikely — but "unlikely" is not "impossible".

If exact visual fidelity is ever required, the honest fix is to show Teja the
**PDF the worker produced**, not an HTML preview of it.
