# Frameworks, runtimes and dependencies — snapshot 2026-11-05

**Dated record — never edited.** Versions are read from the manifests at `00ecabb`. They are
not taken from memory. Regenerate the counts with `node scripts/repo-stats.mjs`. To list
versions, read each `package.json`, `supabase/functions/deno.json` and `pnpm-workspace.yaml`.

## Runtimes and toolchain

| Layer | What | Version / pin | Where declared |
|---|---|---|---|
| Language | TypeScript (84.6 % of code) | `typescript ^5.8.0` in manifests, **forced to 5.9.3** by the workspace override | `pnpm-workspace.yaml` `overrides` |
| Node | server-side JS runtime (worker, packages, Vercel function, tests) | `>=24.0.0 <25.0.0` | root `package.json` `engines` |
| Deno | edge-function runtime (Supabase) | CI checks with Deno v2.9.6 | `.github/workflows/ci.yml` (`denoland/setup-deno`) |
| Browser | React SPA | ES2022 + DOM lib | `apps/web/tsconfig.json` |
| Package manager | **pnpm only** | `pnpm@11.25.0` (`packageManager` + `engines`); `preinstall: pnpm dlx only-allow pnpm` | root `package.json` |
| Workspace | monorepo | `packages/*`, `apps/*`, `worker` | `pnpm-workspace.yaml` |
| `.npmrc` | install policy | `prefer-frozen-lockfile=true`, `shamefully-hoist=false`, `engine-strict=true` | `.npmrc` |
| Database | Postgres 17 (Supabase) | — | `supabase/config.toml` |
| Lockfile | pnpm v9 format; 200 resolved packages | — | `pnpm-lock.yaml` |

### Compiler strictness (all TS, from `tsconfig.base.json`)

`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
`noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`,
`verbatimModuleSyntax`, `isolatedModules`, target `es2023`, module `nodenext`. The Deno side
(`supabase/functions/deno.json`) sets the same strict family. `erasableSyntaxOnly` is the reason
Node can run `.ts` files directly with type stripping, with no build step. That is how every
`node --test` run works.

## Frameworks and libraries by component

### `apps/web` — `@applyy/web` (React console)

| Package | Version | Kind | Role |
|---|---|---|---|
| `react` / `react-dom` | 18.3.1 | dep | UI framework |
| `react-router-dom` | 7.18.4 | dep | routing (`BrowserRouter`, 15 routes) |
| `@supabase/supabase-js` | 2.50.0 | dep | DB, auth, storage, edge-function client |
| `@applyy/shared-types`, `@applyy/master-ingest`, `@applyy/master-pdf` | `workspace:*` | dep | schema types, résumé ingest, PDF parse |
| `vite` | **6.4.4** (advisory open, fix 6.4.5) | dev | bundler and dev server |
| `@vitejs/plugin-react` | 4.3.4 | dev | JSX transform |
| `typescript` | ^5.8.0 → 5.9.3 | dev | typecheck (`tsc --noEmit`) |
| `@types/react` / `@types/react-dom` | 18.3.12 / 18.3.1 | dev | types |
| `playwright` | 1.55.1 | dev | e2e (`test/e2eSuite.test.ts`) |

No CSS framework and no state library. Styling is hand-written CSS with design tokens
(`src/styles/tokens.css`, `light-dark()`). State lives in React hooks plus supabase-js. Tests
run on `node --test` with a TSX transpile hook (`test/support/registerTsxHooks.ts`).

### `worker` — `@applyy/worker` (Node + Playwright)

| Package | Version | Kind | Role |
|---|---|---|---|
| `playwright` | 1.55.1 | dep | browser automation (form fill, submit) |
| `@supabase/supabase-js` | 2.50.0 | dep | DB client |
| `@applyy/resume-template`, `@applyy/shared-types` | `workspace:*` | dep | résumé HTML/PDF, types |
| `vitest` | 4.1.12 | dev | test runner (the only package not on `node --test`) |
| `pdfjs-dist` | 4.9.155 | dev | PDF assertions in tests |
| `@types/node` | 24.0.1 | dev | types |
| `typescript` | ^5.8.0 → 5.9.3 | dev | typecheck |

### Root (used by `api/render-job-page.ts`, the Vercel function)

| Package | Version | Role |
|---|---|---|
| `playwright-core` | 1.55.1 | headless page render, no bundled browser |
| `@sparticuz/chromium` | 140.0.0 | Chromium binary sized for serverless |

### `supabase/functions` (Deno)

| Specifier | Version | Role |
|---|---|---|
| `jsr:@supabase/supabase-js` | 2.58.0 (written inline in 7 files; import map `{}`) | DB client. Resolves auth-js 2.72.0, postgrest-js 1.21.4, realtime-js 2.15.5, storage-js 2.12.2, functions-js 2.5.0 (`deno.lock` v5) |

That is the only third-party import on the Deno side. Everything else is `_shared/` code or
workspace packages imported by relative path. Gemini, the ATS APIs and the HTTP transport
are all called with plain `fetch`, with no SDK.

### `packages/*` (all private ESM, source-only exports, no build step)

| Package | Runtime | Purpose | Deps |
|---|---|---|---|
| `@applyy/shared-types` | Node · Deno · browser | the type contract: enums, tables, status flow, profile nodes; parity-tested against migrations | none |
| `@applyy/resume-template` | Node · Deno | one HTML résumé renderer for web preview, worker PDF and edge | shared-types |
| `@applyy/master-ingest` | Node · Deno | reconciles a parsed master profile against the stored one | shared-types |
| `@applyy/master-pdf` | Node · Deno (parses in the browser) | résumé PDF → draft master profile; **no PDF library** | master-ingest, shared-types |
| `@applyy/master-robots` | Node · Deno · browser | RFC 9309 robots.txt gate, fetch injected | **none (deliberate)** |

Each package has the devDeps `@types/node ^24.0.0` and `typescript ^5.8.0`.

## Dependency counts

| Measure | Value |
|---|---|
| Direct npm packages (union across 8 manifests) | **19** |
| Resolved in `pnpm-lock.yaml` (direct + transitive) | **200** (pnpm audit: 47 prod, 152 dev, 66 optional) |
| Deno third-party specifiers | **1** (`jsr:@supabase/supabase-js@2.58.0`) |
| Workspace packages | **7** (`apps/web`, `worker`, 5 × `packages/*`) |
| Security overrides | `source-map-js: 1.2.2` (GHSA-68fv-2mgg-jv7q), `typescript: 5.9.3` |
| Allowed install scripts (`allowBuilds`) | `esbuild`, `playwright`, `@playwright/test` |

Per manifest (deps / devDeps): `apps/web` 7/6 · root 2/0 · `worker` 4/4 · `master-pdf` 2/2 ·
`master-ingest` 1/2 · `resume-template` 1/2 · `master-robots` 0/2 · `shared-types` 0/2.

**This is a small dependency surface, and it is a choice.** Nothing here pulls in a UI kit, a
state library, an ORM, an LLM SDK, a PDF library or an HTTP client. Each of those is
hand-written or comes from the platform. The cost is more code to own. The gain is a 200-package
lockfile and zero prod advisories (see
[../security/2026-11-05-vulnerability-remeasure.md](../security/2026-11-05-vulnerability-remeasure.md)).

## Version skew to know about

| Skew | Detail | Risk |
|---|---|---|
| supabase-js | Node side 2.50.0 · Deno side 2.58.0 | behaviour differences between worker and edge for the same call |
| Playwright | declared 3 times: `apps/web` and `worker` (`playwright` 1.55.1), root (`playwright-core` 1.55.1) | all three must move together with the lockfile (`CLAUDE.md` §8) |
| TypeScript | manifests say `^5.8.0`, override forces `5.9.3` | the manifests understate the real version |
| Stale comments | `apps/web/package.json` says "nine settings pages" (there are 6 config + 9 operations); `tsconfig.base.json` mentions "Vite 7" (pinned 6.4.4) | misleading to a reader, harmless at runtime |
