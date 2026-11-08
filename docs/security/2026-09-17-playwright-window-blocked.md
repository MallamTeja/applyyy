# Window 3 (playwright) — blocked, re-scoped, then landed without local execution

> **Status 2026-11-08:** Historical. The bump landed in `b62be33`, and both `worker/package.json` and `apps/web/package.json` still pin `playwright` 1.55.1. The rule this record found (bump both manifests and the lockfile together) is kept in the repo `CLAUDE.md` §8. The 2026-11-05 re-measure corrects the "8 vulns fixed" claim: only 3 alerts were Playwright. The body below is the original record, unedited.

**Date:** 2026-09-17 · **Session:** `applyyy-95`
**Status:** **BUMPED.** Both manifests and the lockfile moved `1.49.1 -> 1.55.1`.
**NO REGRESSION WAS ESTABLISHED LOCALLY, AND NOTHING HERE IS "VERIFIED"** — see §5.

> §1–§4 below are the record of the **first** attempt, which stopped before touching
> anything. They are kept rather than rewritten: the blocker and the three corrections
> are why the second attempt had the scope it did. §5 records what actually landed.

This is a **delta to** [`2026-09-17-dependency-remediation-plan.md`](./2026-09-17-dependency-remediation-plan.md),
not a second account of the same advisory. The plan already covers `playwright` at four
places (`:124` target, `:158` tier, `:226` risk, `:261` Window 3) and it is correct. Read
the plan for the advisory; read this only for the two things the plan does not say.

---

## 1. The blocker: `playwright` is declared TWICE, and the two halves cannot be bumped together

| Manifest | Kind | Pinned |
|---|---|---|
| `worker/package.json:24` | **`dependencies`** (production) | `1.49.1` |
| `apps/web/package.json:26` | `devDependencies` | `1.49.1` |

`GHSA-7mvr-c777-76hp` is scoped `<1.55.1`, so **both** are vulnerable. Bumping one leaves
the advisory open and additionally splits the lockfile across two `playwright` versions,
which means two sets of browser binaries on any machine or runner that installs.

The window as scheduled granted one writer `worker/package.json` and `pnpm-lock.yaml`, and
explicitly forbade "every other package.json". **A coherent fix needs both manifests, so
the window cannot be executed as partitioned.** Widening a partition from inside it is the
one thing the tree's rules never permit, so this stopped here.

Three ways out, for whoever schedules the next attempt:

1. **One writer holds both manifests plus the lockfile.** Simplest. Makes the fix atomic
   and the rollback a single `git checkout -- <3 paths>`.
2. **A `pnpm-workspace.yaml` override**, the way `typescript: "5.9.3"` is already pinned
   there. One number in one place, and it cannot drift back out of step. Costs a fourth
   file in the partition.
3. **Bump `worker` only**, accepting a known-incomplete fix and a two-version tree.
   Not recommended: it closes the production-reachable half while doubling browser
   downloads, and a half-closed advisory reads as closed in a count.

## 2. The plan says verify on CI. A local suite run cannot verify this advisory.

Plan `:261`: *"Verify on a CI run, not locally — the advisory is about install-time
integrity, and CI is where it installs."*

That is right, and it matters more than it looks. The defect is that `playwright`
**downloads browser binaries without verifying SSL**. A green local test suite exercises
browsers that are **already on disk** and were fetched by the OLD version. It demonstrates
nothing about the thing that was fixed. This is the repo's standing failure shape —
**a guard that passes for a reason unrelated to what it claims to check** — wearing a
green checkmark.

Verifying this properly means a clean install on a GitHub Actions runner. Locally, the
most that can be honestly claimed is *"the bump did not break the suite"*, which is a
regression check, not a verification of the fix.

## 3. Corrections to how this item was described to me

Recorded because the same description will otherwise reach the next session.

| Claim | Reality |
|---|---|
| "It is in **no** security doc" | It is in the remediation plan four times, with the exact target `>= 1.55.1`. |
| `99c42e8` "did not close it", implying an oversight | `99c42e8` scoped itself to Tier 1 **in its own commit message** — *"Dev-only and CI advisories are W2-W4 and are deliberately not touched here."* It deferred by design and said so. |
| It "jumped the queue" / sat "unowned" | It is **Window 3** of a documented four-window sequence. |

**The real finding is sharper than "it was missed", and survives all three corrections:**
the plan files `playwright` under *Tier 2 — supply-chain / CI integrity*, "not
user-reachable". But in `worker` it is a **production `dependencies` entry**, and the
worker is the component that types into real ATS forms and submits applications. The plan
half-sees this — `:158` says "integrity of its browser binaries is worth more than the
severity implies" — but the tier label still routes it behind two dev-only windows.
Tier 2's own text argues for Tier 1 treatment.

That is a question for whoever owns the plan, not a unilateral re-tiering from here.

---

## 4. Measurements taken (read-only, nothing written)

```
BEFORE, at 0fe8ca5:
  pnpm audit --json -> {"info":0,"low":2,"moderate":14,"high":3,"critical":2}   (21 total)
  GHSA-7mvr-c777-76hp  high  playwright  vulnerable: <1.55.1  patched: >=1.55.1
```

Target verified **against the advisory's own range**, not inherited from the plan's number.
`>=1.55.1` is satisfied by `1.55.1` exactly — it is the first patched version, not a
version inside a still-vulnerable band. This check is not ceremonial: the plan's original
`react-router` target `6.30.4` sat **inside** the vulnerable range `>=6.30.2 <=6.30.5`, and
installing it would have *added* an advisory. `6.30.6` shipped instead.

**`pnpm audit` does not write `pnpm-lock.yaml`** — confirmed by `git status` immediately
after the run. That distinguishes it from `pnpm run typecheck`, which does, and makes
`audit` safe to run inside someone else's lockfile window.

---

## 5. What landed (window re-opened with option (a))

The orchestrator re-scoped the window to hold **both** manifests plus the lockfile
atomically, choosing that over a `pnpm-workspace.yaml` override on the grounds that an
override "makes the version invisible at the two places a reader looks for it, and this
repo's dominant failure is things being true somewhere other than where you look."

| | Before | After |
|---|---|---|
| `worker/package.json:24` (production dep) | `1.49.1` | `1.55.1` |
| `apps/web/package.json:26` (devDependency) | `1.49.1` | `1.55.1` |
| `pnpm audit` totals | 2 crit / **3 high** / 14 mod / 2 low = **21** | 2 crit / **2 high** / 14 mod / 2 low = **20** |
| `GHSA-7mvr-c777-76hp` | present | **absent** |

**Lockfile diff: 11 insertions, 11 deletions — `playwright` and `playwright-core` only.**
Nothing else moved: no transitive drift, no unrelated package resolved to a new version.
Produced with `pnpm install --lockfile-only`, which resolves and writes the lockfile
without linking `node_modules` — chosen deliberately, because four sessions share this
working tree and a real install would have mutated the `node_modules` a peer's test run
was reading from.

Exactly one high closed and nothing added. That is the whole intended effect.

### Why this says "no regression was not established", and not "verified"

**Nothing was executed against 1.55.1. Not the test suite, not even `tsc`.** With
`--lockfile-only`, `worker/node_modules/playwright` is still `1.49.1`, so a suite run or a
typecheck would have exercised the OLD version and reported green for a reason entirely
unrelated to the change. That green would have been worse than no run at all — it is this
repo's signature failure, a guard passing for a reason unconnected to its claim.

Running anything meaningful locally requires a real install, and a real install requires a
browser download. Measured rather than assumed, by unpacking `playwright-core@1.55.1`
outside the repo and reading its `browsers.json`:

| | cached on this machine | required by 1.55.1 |
|---|---|---|
| chromium | `1148` | **`1193`** |
| chromium headless shell | `1148` | **`1193`** |
| ffmpeg | `1010` | **`1011`** |

None match, all three are `installByDefault`. So a local no-regression run costs three
fresh browser downloads — a Teja decision, not one to take unasked, and the reason this
landed with the honest label instead of a green one.

### And a local run would not have verified the fix anyway

Worth separating, because the two are easy to conflate. Even a full local install with
browsers would only establish **no regression**. The advisory is that playwright
**downloads browser binaries without verifying SSL** — an *install-time* defect. The only
thing that exercises it is a clean install, and the place that happens is CI. The
remediation plan already says exactly this at `:261`, and it is right.

**So the honest status is: the advisory is closed in the dependency graph, and the bump is
unexercised. The next CI run is the first real test of both.**

### Orchestrator ruling recorded here, not a finding of this session

`applyyy-94` **ruled playwright Tier 1 for prioritisation** — a production `dependencies`
entry in the component that submits real applications — and moved this window ahead of W2.
The reasoning is that Tier 2's own text ("integrity of its browser binaries is worth more
than the severity implies") already argues for Tier 1 handling, so the label contradicted
the paragraph beneath it.

Flagged as a ruling rather than a finding so that whoever next owns
`2026-09-17-dependency-remediation-plan.md` can disagree with the reasoning rather than
just the conclusion. **The plan file itself still says Tier 2** — it was in nobody's write
partition during this window, so the ruling and the document currently disagree, and the
document is the one people will read.
