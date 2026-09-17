# Dependency vulnerability remediation plan

**Date:** 2026-09-17
**Status:** **W1 SHIPPED** at `99c42e8` (13:00 IST). **W3 SHIPPED** at `b62be33` (17:30 IST),
out of order and re-tiered — see **A5**. **W2 and W4 open.**
**Source:** `pnpm audit` run 2026-09-17 against the committed lockfile
**Latest measured count:** **20** (2 crit / 2 high / 14 mod / 2 low) at `b62be33`, down from
26 at the time of writing.

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

### A5. `playwright` is Tier 1, and W3 shipped ahead of W2

**Re-tiered by orchestrator ruling (`applyyy-94`, 2026-09-17 17:29), not by a finding
of this document's authors.** Recorded with the reasoning attached so the next owner can
disagree with the reasoning rather than only the conclusion:

> playwright is "a production `dependencies` entry in the component that types into real
> ATS forms and submits applications, so 'not user-reachable' is false of it."

The plan half-saw this already — the Tier 2 paragraph said "integrity of its browser
binaries is worth more than the severity implies" — and then routed it behind two
dev-only windows anyway. **A correct description filed under the wrong heading is harder
to catch than an omission, because everything you read about it is true.**

**Tier 2 is now empty.** It contained exactly one package. A tier invented for a single
item that turns out to belong in another tier is a classification that never earned its
keep; see the note under the Tier 2 heading for what the axis was actually conflating.

**Checked for a second instance rather than assumed** — is any other advisory-carrying
package a production `dependencies` entry wearing a dev/CI label? Enumerated from both
manifests: `worker` ships `@applyy/resume-template`, `@applyy/shared-types`,
`@supabase/supabase-js`, `playwright`; `apps/web` ships `@applyy/master-ingest`,
`@applyy/shared-types`, `@supabase/supabase-js`, `react`, `react-dom`, `react-router-dom`.
Of those with advisories, `supabase-js` and `react-router` were already Tier 1.
**`playwright` was the only misfiling.** Everything remaining in Tier 3 is a genuine
devDependency, and the Vite/esbuild advisories are dev-*server* defects that `vite build`
does not reach — that part of the original reasoning holds.

**W3 SHIPPED at `b62be33`, ahead of W2**, as a consequence of the re-tier. See the Window 3
entry for its honest status; **"shipped" there does not mean "exercised".**

---

## Why the lockfile is single-owner, and installs happen only in scheduled windows

> **Heading renamed 2026-09-17.** It read *"Why nothing has been installed"*, which became a
> false statement the moment W1 shipped — and a heading is what people scan, so a stale one
> misinforms readers who never reach the paragraph correcting it. The rule this section
> states is still live; only its framing as a present-tense status had expired.
>
> **SUPERSEDED — the body below described the state on 2026-09-17 at 12:40 and is no longer
> true.** Two windows have since installed: W1 at `99c42e8` and W3 at `b62be33`. The
> single-owner rule below still stands and is still how windows are opened; only the
> "nothing has been installed" claim has expired. Kept rather than deleted because the
> rule it states is the reason the windows are scheduled at all.

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

**The "Current" column below is as of 12:40 and three rows have since moved.** It is left
unedited because the advisory counts are keyed to those versions; the live column is on the
right.

| Package | Advisories | Current (12:40) | Needs | **Now** |
|---|---|---|---|---|
| `vite` | 13 | 6.0.3 | >= 6.4.3 | 6.0.3 — **open, W2** |
| `react-router` / `@remix-run/router` | 6 | 6.28.0 | >= 6.30.4 — **stale, see A1** | 6.30.6 — partly closed, **2 remain, need v7** (A2) |
| `vitest` / `@vitest/mocker` | 4 | 2.1.8 | >= 4.1.11 | 2.1.8 — **open, W4** |
| `playwright` | 1 | 1.49.1 | >= 1.55.1 | **1.55.1 — CLOSED, `b62be33`** |
| `esbuild` | 1 | transitive | >= 0.25.0 | transitive — **open, rides W2/W4** |
| `@supabase/auth-js` | 1 | via supabase-js 2.47.10 | >= 2.70.0 | **closed** via supabase-js 2.50.0 (`99c42e8`) |

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
| `playwright` **(moved here from Tier 2, A5)** | downloads and installs browsers without verifying integrity | **high** — **CLOSED, `b62be33`** |
| `@remix-run/router` | XSS via open redirect | **high** |
| `react-router` | open redirect via untrusted input; `//` and backslash paths; constructor injection via deserialization | moderate ×4 |
| `@supabase/auth-js` | insecure path routing from malformed user input | low |

These run **in the browser, in production**, on
`https://applyyy.vercel.app`. An open redirect on a dashboard that holds a
Supabase session is the one class here with a plausible attack story: a crafted
link that bounces an authenticated operator off-site.

**This tier is the actual priority**, despite containing no criticals.

### Tier 2 — supply-chain / CI integrity — **EMPTY, see A5**

| Package | Advisory | Severity |
|---|---|---|
| ~~`playwright`~~ | **moved to Tier 1 by orchestrator ruling** — production `dependencies` in `worker` | ~~high~~ |

Its original justification is preserved because it is the evidence that the tier was wrong:
*"Reaches the GitHub Actions runner that submits applications. Not user-reachable, but it is
the one component that types into real ATS forms, so integrity of its browser binaries is
worth more than the severity implies."* Every clause after the comma argues against the
label the sentence opens with.

**What the axis was conflating.** The heading sorts by *supply-chain vs runtime*; the prose
sorts by *reaches a user vs does not*. Those are different questions and they disagree on
exactly this package — it is a supply-chain defect **in a production runtime dependency**.
Tier 1's own definition is "ships to production, reachable by a real user", and the operator
*is* a real user of the worker's output. **If this scheme is kept, the tier test should be
"does a failure here reach something outside this laptop", asked once, rather than two tests
sharing three buckets.** Flagged, not rewritten: re-deriving the tiers is a larger change
than this window, and W2/W4 depend on the existing numbering.

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

> **THE SEQUENCE BELOW IS NO LONGER THE ORDER THIS HAPPENED IN.** Actual order: **W1
> (`99c42e8`) → W3 (`b62be33`) → W2, W4 still open.** W3 jumped W2 because the A5 re-tier
> made it Tier 1. The numbering is kept as written so existing references to "W2" and "W4"
> stay meaningful — it is a set of window *names*, not a running order. Read the per-window
> status lines, not the ordinal.

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

**Window 3 — ~~Tier 2~~ TIER 1 playwright. SHIPPED `b62be33`, 2026-09-17 17:30, ahead of
W2.** Bumped `1.49.1 -> 1.55.1` in **both** manifests in one commit —
`worker/package.json` (production dep) and `apps/web/package.json` (devDependency). It was
declared twice; bumping either alone leaves `GHSA-7mvr-c777-76hp` open and splits the
lockfile across two browser binary sets. Lockfile diff was 11 insertions / 11 deletions,
`playwright` and `playwright-core` only. **`pnpm audit` 21 → 20, one high removed, nothing
added.**

> **"SHIPPED" HERE DOES NOT MEAN "EXERCISED", AND MUST NOT BE READ AS "VERIFIED".** Nothing
> ran against 1.55.1 — not the suite, not `tsc`. The lockfile was produced with
> `pnpm install --lockfile-only`, which resolves without linking, so the installed copy is
> still 1.49.1 and any run would have exercised the OLD version and gone green for an
> unrelated reason. A local run needs three browser downloads (1.55.1 pins chromium `1193`
> and ffmpeg `1011`; the machine has `1148` and `1010` — measured from
> `playwright-core@1.55.1`'s `browsers.json`, not assumed). That download was **ruled
> against** — see the deferral below; it was an open question for about twelve minutes and
> is not one now. **Honest status: closed in the dependency graph, unexercised locally by
> decision.**

**RULED 2026-09-17 17:42 — DELIBERATELY DEFERRED TO CI. Not "pending a decision".** Teja
chose this directly at 17:37 and the orchestrator concurrently; they agree. The reasoning:
even a full local install with browsers establishes only *no regression*, while the defect
is install-time, so a clean CI install gives something strictly stronger for free.

### "CI" is three workflows and they do different things — name the one you mean

Checked against `.github/workflows/`, because deferring to "CI" is only a real plan if you
know which run you are deferring to.

| Workflow | Schedule (IST) | Installs deps | Browsers |
|---|---|---|---|
| `scout.yml` | **23:30, 05:30, 11:30, 17:30** (`0 */6 * * *`) | `--frozen-lockfile` `:58` | **no cache, no install step** |
| `keepalive.yml` | 11:45, every 3rd day (`15 6 */3 * *`) | `--frozen-lockfile` `:74` | none |
| `apply.yml` | **08:00 daily** (`30 2 * * *`) | `--frozen-lockfile` `:110` | cache `:118`, install `:127` |

**`apply.yml` is the one that submits real applications**, and its browser cache key is
`playwright-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}` (`:119`). `b62be33` changed
the lockfile, so the key changed, so the cache **misses by construction** and `:127`
re-downloads Chromium. That is not a risk the bump runs — it is a guarantee. The workflow's
own comment anticipates it: *"Keyed on the lockfile so a Playwright version bump invalidates
the cache automatically rather than serving a mismatched browser."*

**But `apply.yml` is NOT first contact.** `scout.yml` runs every six hours and does
`pnpm install --frozen-lockfile` with no browser cache, so the first clean-runner install of
`playwright@1.55.1` happens at **23:30 IST, roughly eight hours before `apply.yml`** — and
`scout.yml` submits nothing. If the bump breaks installation or lockfile resolution, it
goes red there, harmlessly, first. That is a materially better first signal than the
submission run and it was not visible until the workflows were actually read.

> Not verified, flagged rather than asserted: whether `scout.yml`'s plain
> `--frozen-lockfile` also pulls browsers via playwright's postinstall, given
> `pnpm-workspace.yaml` sets `allowBuilds: playwright: true` and no
> `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` is set anywhere. If it does, `scout.yml` silently
> downloads ~130MB four times a day with no cache. **That would be a pre-existing cost
> this bump merely makes visible, not a new one** — but nobody has measured it.

### The option that was in neither (a) nor (b)

`apply.yml` accepts `workflow_dispatch` with a `dry_run` input (`:26-33`) that **defaults to
`'true'`**, deliberately, so an operator clicking through cannot submit by accident
(constraint #15). So the identical path — fresh frozen-lockfile install, cache miss, browser
download, worker startup — can be exercised **on demand, submitting nothing.**

That is strictly better than both offered options, and it surfaced only because someone
checked whether "CI installs" was even true. **When a plan defers verification to CI, name
the workflow, its trigger and its side effects.** "CI" is not one thing, and here the
cheapest safe answer was hiding behind the word.

Triggering it is Teja's, not a session's.

### Vercel, separately

`apps/web`'s playwright is a devDependency and Vercel installs devDependencies, so **the
first Vercel build after `b62be33` will fetch the new Chromium revision and be slower than
usual.** Do not read a slow first build as a failed one — this repo has already lost four
days to a deploy failure nobody noticed, and the inverse error is just as available.

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

- ~~**It does not install anything.** Lockfile untouched, deliberately.~~
  **EXPIRED.** True when written; two windows have since installed (`99c42e8`, `b62be33`).
  The lockfile is still single-owner and still only writable inside a scheduled window.
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
4. **`@supabase/supabase-js` is pinned exactly** — now `2.50.0`, not the `2.47.10` this
   item was written against (`99c42e8` moved both). The point stands and was borne out
   twice: both manifests must move together or the two trees resolve different `auth-js`
   versions. **`playwright` turned out to be a second package pinned in both trees**, and
   W3 hit exactly this — see A5. **Before opening any window, grep every manifest for the
   package first**; "which manifests declare this?" is a cheaper question than a split
   lockfile.
5. **The tier scheme needs one test, not two.** Flagged in A5 and under the Tier 2 heading:
   the headings sort by supply-chain vs runtime, the prose sorts by reaches-a-user vs not,
   and they disagreed on `playwright`. Not re-derived here because W2/W4 reference the
   existing numbering.
6. **W3 is closed in the dependency graph but unexercised.** The first CI run after
   `b62be33` is the first execution of `playwright@1.55.1` anywhere. If it goes red, that
   is the bump, and `git revert b62be33` is one command.
