# Frameworks, runtimes and dependencies

_Last verified against code: 2026-11-08 (2a9ac31)._

Versions are read from the manifests, not from memory. To re-check, read each
`package.json`, `supabase/functions/deno.json` and `pnpm-workspace.yaml`. Dependency counts
come from `node scripts/repo-stats.mjs`.

## Runtimes and toolchain

| Layer | What | Version / pin | Where declared |
|---|---|---|---|
| Language | TypeScript | `typescript ^5.8.0` in manifests, **forced to 5.9.3** by the workspace override | `pnpm-workspace.yaml` `overrides` |
| Node | server-side JS runtime (worker, packages, Vercel function, tests) | `>=24.0.0 <25.0.0` | root `package.json` `engines` |
| Deno | edge-function runtime (Supabase) | CI checks with Deno v2.9.6 | `.github/workflows/ci.yml` (`denoland/setup-deno`) |
| Browser | React SPA | ES2022 + DOM lib | `apps/web/tsconfig.json` |
| Package manager | **pnpm only** | `pnpm@11.25.0` (`packageManager` + `engines`); `preinstall: pnpm dlx only-allow pnpm` | root `package.json` |
| Workspace | monorepo | `packages/*`, `apps/*`, `worker` | `pnpm-workspace.yaml` |
| `.npmrc` | install policy | `prefer-frozen-lockfile=true`, `shamefully-hoist=false`, `engine-strict=true` | `.npmrc` |
| Database | Postgres 17 (Supabase) | `major_version = 17` | `supabase/config.toml` |
| Lockfile | pnpm lockfile | — | `pnpm-lock.yaml` |

`supabase/functions` is **not** a pnpm workspace member. It is a Deno project with its own
`deno.json` and `deno.lock`. Its tests still run on Node (`pnpm run test:functions`, root
`package.json`), because `deno.json` excludes `*.test.ts` from `deno check`.

### Compiler strictness (all TS, from `tsconfig.base.json`)

`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
`noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`,
`verbatimModuleSyntax`, `isolatedModules`, target `es2023`, module `nodenext`. The Deno side
(`supabase/functions/deno.json` `compilerOptions`) restates the strict family, because Deno
does not read `tsconfig.base.json`. `erasableSyntaxOnly` is the reason Node can run `.ts`
files directly with type stripping, with no build step. That is how every `node --test` run
works. It is also why the TypeScript floor is 5.8: older versions reject that option.

## Frameworks and libraries by component

### `apps/web` — `@applyy/web` (React console)

| Package | Version | Kind | Role |
|---|---|---|---|
| `react` / `react-dom` | 18.3.1 | dep | UI framework |
| `react-router-dom` | 7.18.4 | dep | routing (`apps/web/src/app/routes.ts`) |
| `@supabase/supabase-js` | 2.50.0 | dep | DB, auth, storage, edge-function client |
| `@applyy/shared-types`, `@applyy/master-ingest`, `@applyy/master-pdf` | `workspace:*` | dep | schema types, résumé ingest, PDF parse |
| `vite` | 6.4.5 | dev | bundler and dev server |
| `@vitejs/plugin-react` | 4.3.4 | dev | JSX transform |
| `typescript` | ^5.8.0 (5.9.3 by override) | dev | typecheck (`tsc --noEmit`) |
| `@types/react` / `@types/react-dom` | 18.3.12 / 18.3.1 | dev | types |
| `playwright` | 1.55.1 | dev | e2e (`apps/web/test/e2eSuite.test.ts`) |

No CSS framework and no state library. Styling is hand-written CSS with design tokens
(`apps/web/src/styles/tokens.css`, `light-dark()`; see `docs/ui/theming-convention.md`). State
lives in React hooks plus supabase-js. Tests run on `node --test` with a TSX transpile hook
(`apps/web/test/support/registerTsxHooks.ts`).

### `worker` — `@applyy/worker` (Node + Playwright)

| Package | Version | Kind | Role |
|---|---|---|---|
| `playwright` | 1.55.1 | dep | browser automation (form fill, submit) |
| `@supabase/supabase-js` | 2.50.0 | dep | DB client |
| `@applyy/resume-template`, `@applyy/shared-types` | `workspace:*` | dep | résumé HTML/PDF, types |
| `vitest` | 4.1.12 | dev | test runner (the only package not on `node --test`) |
| `pdfjs-dist` | 4.9.155 | dev | PDF assertions in tests |
| `@types/node` | 24.0.1 | dev | types |
| `typescript` | ^5.8.0 (5.9.3 by override) | dev | typecheck |

### Root (used by `api/render-job-page.ts`, the Vercel function)

| Package | Version | Role |
|---|---|---|
| `playwright-core` | 1.55.1 | headless page render, no bundled browser |
| `@sparticuz/chromium` | 140.0.0 | Chromium binary sized for serverless; 140 because `playwright-core` 1.55.1 drives Chromium 140 |

Both are exact pins and production dependencies, so Vercel ships them in the function bundle
(root `package.json`, `"// dependencies"` comment).

### `supabase/functions` (Deno)

| Specifier | Version | Where declared |
|---|---|---|
| `@supabase/supabase-js` → `jsr:@supabase/supabase-js` | 2.58.0 | `supabase/functions/deno.json` `imports` (the import map) |

Since 2026-11-05 the version is pinned **once**, in the import map. Every file imports the bare
name `@supabase/supabase-js`. Deploys must pass `--import-map supabase/functions/deno.json`
(`CLAUDE.md` §3); without it the server-side bundler cannot resolve the bare name.

That is the only third-party import on the Deno side. Everything else is `_shared/` code or
workspace packages imported by relative path (for example
`supabase/functions/_shared/contracts/shared-types.ts`). Gemini, the ATS APIs and the HTTP
transport are all called with plain `fetch`, with no SDK.

### `packages/*` (all private ESM, source-only exports, no build step)

| Package | Runtime | Purpose | Deps |
|---|---|---|---|
| `@applyy/shared-types` | Node · Deno · browser | the type contract: enums, tables, status flow, profile nodes; parity-tested against migrations | none |
| `@applyy/resume-template` | Node · Deno | one HTML résumé renderer for web preview, worker PDF and edge | shared-types |
| `@applyy/master-ingest` | Node · Deno · browser | reconciles a parsed master profile against the stored one | shared-types |
| `@applyy/master-pdf` | Node · browser | résumé PDF to draft master profile; **no PDF library** (`packages/master-pdf/src/load-pdf.ts`) | master-ingest, shared-types |
| `@applyy/master-robots` | Node · Deno · browser | RFC 9309 robots.txt gate, fetch injected | **none (deliberate)** |

Each package has the devDeps `@types/node ^24.0.0` and `typescript ^5.8.0`. Each exports raw
`.ts` (`"exports": { ".": "./src/index.ts" }`). A build step would create a second, stale copy
of the code, which is why there is none.

## Dependency counts (as of 2026-11-08)

| Measure | Value | Regenerate |
|---|---|---|
| Direct npm packages (union across 8 manifests) | 19 | `node scripts/repo-stats.mjs` |
| Resolved in `pnpm-lock.yaml` (direct + transitive) | 200 | same |
| Deno third-party specifiers | 1 | `supabase/functions/deno.json` `imports` |
| Workspace packages | 7 (`apps/web`, `worker`, 5 × `packages/*`) | `pnpm-workspace.yaml` |
| Overrides | `typescript: 5.9.3`; `source-map-js: 1.2.2` (security pin, GHSA-68fv-2mgg-jv7q) | `pnpm-workspace.yaml` |
| Packages allowed to run install scripts | `esbuild`, `playwright`, `@playwright/test` | `pnpm-workspace.yaml` (`onlyBuiltDependencies`, `allowBuilds`) |

**This is a small dependency surface, and it is a choice.** Nothing here pulls in a UI kit, a
state library, an ORM, an LLM SDK, a PDF library or an HTTP client. Each of those is
hand-written or comes from the platform. The cost is more code to own. The gain is a small
lockfile and a small attack surface. For the current advisory list, run `pnpm audit --prod`.

## Version skew to know about

| Skew | Detail | Risk |
|---|---|---|
| supabase-js | Node side 2.50.0 (`apps/web`, `worker`) · Deno side 2.58.0 (`deno.json`) | the same call can behave differently in the worker and at the edge |
| Playwright | declared 3 times: `apps/web` and `worker` (`playwright` 1.55.1), root (`playwright-core` 1.55.1) | all three must move together with the lockfile (`CLAUDE.md` §8); `@sparticuz/chromium` must match the Chromium major |
| TypeScript | manifests say `^5.8.0`, override forces `5.9.3` | the manifests understate the real version |
| Stale comments | `apps/web/package.json` `description` says "nine settings pages"; `tsconfig.base.json:7` mentions "Vite 7" (pin is 6.4.5) | misleading to a reader, harmless at runtime |
