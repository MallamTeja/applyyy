# Dependency vulnerability remediation plan

**Date:** 2026-09-17
**Status:** plan only — **nothing installed, lockfile untouched**
**Source:** `pnpm audit` run 2026-09-17 against the committed lockfile

---

## Why nothing has been installed

`pnpm-lock.yaml` is **single-owner** in this repo (`CLAUDE.md` §4: *"Do not run
`pnpm install` without the orchestrator scheduling it. The lockfile is
single-owner and rewriting it while four sessions work costs a day."*).

Every fix below rewrites the lockfile. So this file is the plan; the install is
a scheduled window someone else opens.

---

## Counts

`pnpm audit` reports **26 advisories**: 2 critical, 4 high, 17 moderate, 3 low.

GitHub Dependabot reports **44** on the same tree. The gap is not a
disagreement — Dependabot counts per-manifest occurrences and walks transitive
dev dependencies differently. Treat 26 as the number of *distinct advisories*
and 44 as the number of *alert rows*. Fixing the six packages below closes both.

**26 advisories, 6 packages.** The long list is mostly one package counted many
times: `vite` alone accounts for 13.

| Package | Advisories | Current | Needs |
|---|---|---|---|
| `vite` | 13 | 6.0.3 | >= 6.4.3 |
| `react-router` / `@remix-run/router` | 6 | 6.28.0 | >= 6.30.4 |
| `vitest` / `@vitest/mocker` | 4 | 2.1.8 | >= 4.1.11 |
| `playwright` | 1 | 1.49.1 | >= 1.55.1 |
| `esbuild` | 1 | transitive | >= 0.25.0 |
| `@supabase/auth-js` | 1 | via supabase-js 2.47.10 | >= 2.70.0 |

---

## Severity is the wrong ranking here

CVSS severity answers *"how bad is this bug?"* The question that matters is
*"does it reach a user of this system?"* For this repo those give different
orders, and following severity alone would have us fix the dev-only critical
first and the production open-redirect fourth.

**Classify by reachability, then by severity within each tier.**

### Tier 1 — ships to production, reachable by a real user

| Package | Advisory | Severity |
|---|---|---|
| `@remix-run/router` | XSS via open redirect | **high** |
| `react-router` | open redirect via untrusted input; `//` and backslash paths; constructor injection via deserialization | moderate ×4 |
| `@supabase/auth-js` | insecure path routing from malformed user input | low |

These run **in the browser, in production**, on
`https://applyyy.vercel.app`. An open redirect on a dashboard that holds a
Supabase session is the one class here with a plausible attack story: a crafted
link that bounces an authenticated operator off-site.

**This tier is the actual priority**, despite containing no criticals.

### Tier 2 — supply-chain / CI integrity

| Package | Advisory | Severity |
|---|---|---|
| `playwright` | downloads and installs browsers without verifying integrity | **high** |

Reaches the GitHub Actions runner that submits applications. Not
user-reachable, but it is the one component that types into real ATS forms, so
integrity of its browser binaries is worth more than the severity implies.

### Tier 3 — developer machine only

| Package | Advisories | Severity |
|---|---|---|
| `vitest` | RCE via malicious file; arbitrary file read via UI server | **critical ×2** |
| `vite` | 13 × `server.fs.deny` bypass / path traversal / dev-server request forgery | high ×2, moderate ×9, low ×2 |
| `esbuild` | dev server accepts requests from any website | moderate |

**Both criticals are here, and both are dev-only.** Every one of these requires
running `vite dev`, `vitest`, or the Vitest UI locally. `apps/web` deploys as a
**static build** — `tsc --noEmit && vite build` — so no Vite dev server exists
in production. They are real on a laptop with a browser open to a hostile page;
they are not exposed on Vercel.

Still fix them. Just do not let two criticals reorder the queue ahead of the
open redirect that actually ships.

#### Reachability of the two criticals, verified 2026-09-17

An audit finding is a claim about the **lockfile**, not about what this app
runs. Both criticals were checked against the installed tree:

**Critical 1 — Vitest UI arbitrary file read (needs >= 3.2.6): NOT REACHABLE.**
`@vitest/ui` is an **optional peer dependency** of `vitest`
(`pnpm-lock.yaml:1173`, `peerDependenciesMeta … optional: true`). It is declared
in **no manifest in this workspace**, and it is **not present in
`node_modules/.pnpm`** — the installed `@vitest/*` packages are `expect`,
`mocker`, `pretty-format`, `runner`, `snapshot`, `spy`, `utils`. The vulnerable
package is not installed, so there is no code path to reach. It appears in the
audit because the advisory matches the `vitest` version range, not because the
UI server exists here.

**Critical 2 — Vitest RCE via malicious website (needs >= 2.1.9): REACHABLE,
NARROWLY.** Requires `vitest` running in **watch mode** while a browser visits a
hostile page. Only `worker` depends on vitest (`worker/package.json:30`), and
only `worker`'s `test:watch` script starts watch mode. The scripts CI and
`pnpm test` use run `vitest run` (non-watch). So exposure is: a developer who
runs `pnpm --filter @applyy/worker run test:watch` and browses the web on the
same machine at the same time.

This is the distinction that matters for sequencing. The headline "2 criticals"
is really **one narrowly-reachable dev-machine issue and one that cannot fire
at all** — which is why the `vitest` bump stays last despite being the only
critical, and why the production open redirect goes first.

Note also that `@vitest/mocker` resolves against **`vite@5.4.21`**, a second
Vite major present transitively alongside `apps/web`'s `vite@6.0.3`. The Vite
advisories below are scoped to the 6.x range; whether any also apply to the 5.x
copy was **not** checked and is recorded as an open item.

---

## Blast radius — the reason this is not one command

`pnpm audit --fix` would take every bump at once, including two majors, and
rewrite the lockfile in a tree four sessions are working in. Do it in tiers.

| Bump | Kind | Risk |
|---|---|---|
| `react-router-dom` 6.28.0 → 6.30.4 | patch within 6.x | **low** — no API change |
| `@supabase/supabase-js` 2.47.10 → latest 2.x | minor within 2.x | **low** — carries `auth-js` >= 2.70.0 |
| `vite` 6.0.3 → 6.4.3 | minor within 6.x | **low–medium** — verify `vite build` still emits |
| `playwright` 1.49.1 → 1.55.1 | minor | **medium** — re-downloads browsers; `allowBuilds` already permits it |
| `vitest` 2.1.8 → 4.1.11 | **two majors** | **HIGH** — breaking config and API changes |
| `esbuild` → >= 0.25.0 | transitive | resolved automatically by the vite/vitest bumps |

### The `vitest` bump is the dangerous one

2.x → 4.x crosses two majors. It is also the least urgent by reachability —
dev-only — while being the largest breaking change. Do it **last, on its own**,
never in the same window as the others, or a test failure becomes ambiguous
between "the bump broke it" and "the other four bumps broke it".

Note `worker` pins `vitest: 2.1.8` and `apps/web` runs `node --test` instead, so
only the worker suite is at risk.

---

## Recommended sequence

Four windows, each independently verifiable and revertible.

**Window 1 — Tier 1, production reachable.** Bump `react-router-dom` and
`@supabase/supabase-js`. Verify: `pnpm --filter @applyy/web run typecheck`, then
`vite build`, then click through `/discovered` and a settings page — routing and
session are exactly what changed.

**Window 2 — Tier 3 vite.** Bump `vite` to >= 6.4.3. Closes 13 advisories in one
move. Verify: `vite build` emits, and `pnpm --filter @applyy/web run typecheck`
stays green. This is the highest advisory-count-per-unit-risk fix available.

**Window 3 — Tier 2 playwright.** Bump to >= 1.55.1. Verify on a CI run, not
locally — the advisory is about install-time integrity, and CI is where it
installs.

**Window 4 — vitest, alone.** 2.x → 4.x. Expect config churn. Verify:
`pnpm test:workspace` green, and `pnpm test:functions` unaffected (it runs under
`node --test`, not vitest).

### Verification standard for each window

Per `CLAUDE.md` §4 — a green run proves the suite executed, not that it guards
anything:

- run the gate **before** the bump and record the result, so "was it already
  failing?" is answerable;
- after the bump, confirm the gate ran at all (`pnpm --filter web` matches
  nothing — the package is `@applyy/web`);
- `pnpm test` runs functions first; both halves must report.

Do not report a window complete on a green you did not watch execute.

---

## What this plan does not do

- **It does not install anything.** Lockfile untouched, deliberately.
- **It does not bump `typescript`.** `pnpm-workspace.yaml` pins it to 5.9.3 via
  `overrides` for a documented reason; no advisory touches it.
- **It does not touch `supabase/functions/`.** That tree is Deno with its own
  `deno.lock` and is not covered by `pnpm audit` at all — **its dependencies
  have not been audited by this exercise.** Worth a separate pass.

---

## Open items

1. **The Deno tree is unaudited.** `supabase/functions/deno.lock` was not
   examined. `pnpm audit` cannot see it.
2. **A second Vite major is in the tree.** `@vitest/mocker` resolves against
   `vite@5.4.21` while `apps/web` uses `vite@6.0.3`. The 13 Vite advisories
   above are scoped to 6.x ranges. Whether the 5.x copy carries its own
   exposure was not checked — it is dev-only either way, but the count may be
   understated.
3. **Dependabot's 44 vs audit's 26** should be reconciled once after the bumps,
   to confirm no alert class was missed rather than merely recounted.
4. **`@supabase/supabase-js` is pinned exactly** (`2.47.10`) in both `apps/web`
   and `worker`. Both must move together or the two trees resolve different
   `auth-js` versions.
