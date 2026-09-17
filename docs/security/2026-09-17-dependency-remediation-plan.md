# Dependency vulnerability remediation plan

**Date:** 2026-09-17
**Status:** **W1 SHIPPED** at `99c42e8` (13:00 IST). W2–W4 open.
**Source:** `pnpm audit` run 2026-09-17 against the committed lockfile

---

## Amendments — read these before following anything below

This plan was written at 12:40 and parts of it were wrong or went stale within
the hour. Corrections are recorded here rather than silently edited into the
body, so that anyone who read the original can see what changed.

### A1. `react-router-dom` — the plan's target was stale and would have made things worse

The plan said bump to **>= 6.30.4**. That number is wrong. An advisory published
since put `6.30.2`–`6.30.5` in the vulnerable range, patched at **>= 6.30.6**.
The installed `6.28.0` sat *below* that range, so **installing the planned
6.30.4 would have added an advisory that did not previously apply.**

W1 shipped **6.30.6**. Do not "correct" it back to the plan's number.

This is not a reasoning error in the original analysis — 6.30.4 was the right
target when the advisory data was read. **A version number has a shelf life.**
Re-resolve the target against the registry at install time rather than trusting
a number written earlier the same day.

### A2. Tier 1 is BETTER, not CLEAN — do not report it as closed

Two `react-router` advisories **cannot be closed within 6.x**. Both require
**>= 7.18.0**, a major. One of them is the open redirect this plan named as
Tier 1's actual attack story.

Measured after W1: **26 → 21** advisories, and `@remix-run/router`'s XSS-via-open-redirect
(high) and `@supabase/auth-js` (low) are both closed. **Two moderate
`react-router` open-redirect / constructor-injection advisories remain open and
are production-reachable.** They need their own window with the v6 → v7 major
as its subject.

### A3. `@supabase/supabase-js` — take 2.50.0 exactly, never "latest 2.x"

The plan said "latest 2.x". That is wrong and would have shipped a hidden major.

Supabase synchronised every sub-package onto one version line, so the umbrella
package's semver **conceals** what moves underneath it:

| supabase-js | auth-js | postgrest-js |
|---|---|---|
| 2.49.4 | 2.69.1 — still vulnerable | 1.17.7 |
| **2.50.0** | **2.70.0 — patched, the exact minimum** | 1.19.4 — still 1.x |
| 2.116.0 | patched | **2.116.0 — a major** |

`2.116.0` looks like a minor on the umbrella and carries `postgrest-js` across a
major. The blanking guard shipped this morning reads behaviour out of
`postgrest-js` 1.x — `upsert()` computing `columns=` from the union of keys
across the batch. A major could change that, and the guard would stop working
silently while every one of its tests still passed, because they are unit tests
over the payload that never touch postgrest.

**The advisory is the reason for the window. Anything past the patched minimum
is unpaid risk in the only tier that ships to production.** The 2.116.0
modernisation deserves its own window with the postgrest-js major as its subject.

### A4. The verification instruction below is wrong — "green" is not available

Windows 1 and 2 say *"verify: typecheck stays green."* **In a tree with several
concurrent writers there is no green baseline to return to.** The same command
returned 0 errors, then 4, then 0 again across four minutes today — all three
measurements correct, all three describing different moments.

Use an **error-set diff**, not an exit code:

```
cd apps/web
./node_modules/.bin/tsc --noEmit 2>&1 | sort > before.txt   # immediately before install
# ... install ...
./node_modules/.bin/tsc --noEmit 2>&1 | sort > after.txt
diff before.txt after.txt
```

An empty diff means the bump introduced nothing, whatever the exit code. Any new
error is yours to own. **Capture the baseline immediately before installing** —
a baseline twenty minutes old is a different repo.

---

## Why nothing has been installed

`pnpm-lock.yaml` is **single-owner** in this repo (`CLAUDE.md` §4: *"Do not run
`pnpm install` without the orchestrator scheduling it. The lockfile is
single-owner and rewriting it while four sessions work costs a day."*).

Every fix below rewrites the lockfile. So this file is the plan; the install is
a scheduled window someone else opens.

---

## Counts

> **Scope — never quote "26" without this line.** 26 is the total for the trees
> `pnpm audit` can reach: `apps/*`, `packages/*`, `worker`. It is **not** this
> repo's total. `supabase/functions/` is a separate Deno project with its own
> `deno.lock` (3592 bytes, confirmed present) that `pnpm audit` cannot see and
> that **has not been audited by anything**. A second Vite major (`vite@5.4.21`,
> alongside `apps/web`'s `6.0.3`) is also present and its advisories were not
> enumerated. **Absence of a finding here is not a finding of absence.**

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

> **Caveat: W2 may not close `vite` as cleanly as "13" suggests.** The 13
> advisories are scoped to 6.x ranges, and a second copy — `vite@5.4.21`, pulled
> in by `@vitest/mocker` — remains in the tree after this bump. Whether it
> carries its own exposure is **unchecked**. Re-run `pnpm audit` after W2 rather
> than assuming the count went to zero; the 5.x copy leaves with W4, not W2.

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
