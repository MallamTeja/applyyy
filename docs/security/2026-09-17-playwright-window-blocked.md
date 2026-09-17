# Window 3 (playwright) — blocked before any install, and why

**Date:** 2026-09-17 17:2x IST · **Session:** `applyyy-95` · **Repo at:** `0fe8ca5`
**Status:** **NOTHING INSTALLED. NOTHING CHANGED.** `pnpm-lock.yaml` and every
`package.json` are byte-identical to `0fe8ca5`.

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
