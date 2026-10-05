# Dependency audit — re-measure (2026-10-05)

**Measured:** 2026-10-05 ~20:50 IST at HEAD `1938f82`, by `applyyy-d3`.
**Compared against:** [`2026-09-17-dependency-remediation-plan.md`](2026-09-17-dependency-remediation-plan.md)
(its own "latest measured count": **20** at `b62be33`).

## Verdict

**Nothing is new and nothing has been fixed since 2026-09-17.** The set is the same **20 advisories**
(2 critical / 2 high / 14 moderate / 2 low) the plan recorded after W3. GitHub's **36** is the same 20
counted per manifest, not 16 new findings.

| Source | Total | crit | high | mod | low | Regenerate with |
|---|---|---|---|---|---|---|
| `pnpm audit` (unique advisories) | **20** | 2 | 2 | 14 | 2 | `pnpm audit --json` → `.metadata.vulnerabilities` |
| GitHub Dependabot (open alerts) | **36** | 4 | 4 | 24 | 4 | `gh api "repos/{owner}/{repo}/dependabot/alerts?state=open&per_page=100"` |
| 09-17 plan, latest | 20 | 2 | 2 | 14 | 2 | (plan header, at `b62be33`) |

`pnpm audit` exited 1 (advisories present) and **did not write `pnpm-lock.yaml`** (`git status` clean
for it afterwards).

### Why 36 ≠ 20 — a counting artifact, not drift

Dependabot raises one alert **per (advisory, manifest)**. 16 of the 20 advisories are reported twice:
once against `pnpm-lock.yaml` and once against the declaring `package.json` (`apps/web` for vite,
`worker` for vitest). Four are reported only against the lockfile: `esbuild`, `@vitest/mocker`, and the
two `react-router` advisories, because none of them is a direct dependency. 16×2 + 4 = **36**. The
"4 critical, 4 high" is 2 + 2 doubled.

**Trap:** Dependabot labels every lockfile alert `scope: runtime`. That label is wrong for 18 of the
20. vite, vitest and esbuild are dev tooling here. Read the scope off the `package.json` alert, not
the lockfile one.

## Critical and high — prod-reachable first

**None of the critical or high advisories are prod-reachable.** `apps/web` ships a static
`tsc --noEmit && vite build` output, so no Vite dev server exists in production. vitest is a `worker`
devDependency that CI runs as `vitest run` (no watch, no UI server). Exposure is a developer's machine
while the dev server or Vitest UI is listening (plan `:234-267` has the full argument; still valid).

| Sev | Package | Advisory | Path | Prod/dev | Fix version | Window |
|---|---|---|---|---|---|---|
| critical | vitest 2.1.8 | GHSA-9crc-q9x8-hgqq: RCE while the API server listens | `worker>vitest` | **dev** (`worker/package.json:31`) | ≥ 2.1.9 | W4 |
| critical | vitest 2.1.8 | GHSA-5xrq-8626-4rwp: UI server file read/exec | `worker>vitest` | **dev** | ≥ 3.2.6 (major) | W4 |
| high | vite 6.0.3 | GHSA-p9ff-h696-f583: file read via dev-server WebSocket | `apps__web>vite` (+ via `@vitejs/plugin-react`) | **dev** (`apps/web/package.json:29`) | ≥ 6.4.2 | W2 |
| high | vite 6.0.3 / 5.4.x | GHSA-fx2h-pf6j-xcff: `server.fs.deny` bypass on Windows | `apps__web>vite`, `worker>vitest>vite` | **dev** | ≥ 6.4.3 | W2 + W4 |

**Practical consequence of the fix versions:** closing every vitest advisory needs **≥ 4.1.11**
(GHSA-82fw-gwwq-j7x9). That is a 2 → 4 **major**, not the patch bump that the 2.1.9 critical fix
suggests. Size W4 accordingly.

## The only prod-reachable advisories (moderate)

| Package | Advisory | Path | Fix | Note |
|---|---|---|---|---|
| react-router 6.30.6 | GHSA-wrjc-x8rr-h8h6: open redirect via backslash in `<Link>`/`useNavigate` | `apps__web>react-router-dom>react-router` | ≥ 7.18.0 | **Unchanged** since plan A2. A v6 → v7 migration, not a bump |
| react-router 6.30.6 | GHSA-337j-9hxr-rhxg: constructor injection via SSR `deserializeErrors()` | same | ≥ 7.18.0 | SSR hydration path; `apps/web` is client-only, so practical reach is low |

These two are bundled into the browser, so they are **the only advisories that reach a user**, even
though both are moderate.

## New / fixed / unchanged

| Class | Count | Members |
|---|---|---|
| New since 09-17 | **0** | none |
| Fixed since 09-17 (post-`b62be33`) | **0** | none. No dependency manifest changed after W3 |
| Unchanged | **20** | 1 esbuild, 13 vite, 3 vitest + 1 `@vitest/mocker` (one GHSA, two packages), 2 react-router |

The 09-17 plan records no GHSA IDs, so this comparison is **by package, severity and count**, not
ID-for-ID. Package totals match the plan's table at `:170-174` (vite 13, vitest family 4, esbuild 1,
react-router 2 remaining after W1).

## What still closes them

1. **W2: vite 6.0.3 → ≥ 6.4.3** (`apps/web`). Clears 13 vite + esbuild on the `apps/web` path.
   It does **not** zero the vite count, because vitest 2.x pulls its own vite.
2. **W4: vitest 2.1.8 → ≥ 4.1.11** (`worker`). Clears both criticals, the mocker advisory and the
   second vite/esbuild path. Major bump.
3. **react-router v7 migration.** The only user-reachable item, and the largest change. Needs its own
   window.

All three write `pnpm-lock.yaml` and need an orchestrator-scheduled lockfile window
(`CLAUDE.md` §4). None has been scheduled.
