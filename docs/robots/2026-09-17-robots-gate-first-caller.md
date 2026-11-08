# The robots gate gets a caller — and three briefed premises that were wrong

> **Status 2026-11-08:** Historical. The capture script still calls the gate (`worker/scripts/capture-fixture.ts:166`). §6.1 is closed: the gate now runs inside `supabase/functions/_shared/http/transport.ts` for every Deno caller (`111791c`), and the worker apply page is gated (`worker/src/apply-one.ts:47`, `a3b4115`). For current gate behaviour read `packages/master-robots/src/gate.ts` and the banner on [`2026-09-17-robots-gate-design.md`](./2026-09-17-robots-gate-design.md).
> The body below is the original record, unedited.

**Date:** 2026-09-17 · **Session:** `applyyy-95` · **Commit:** `65b7726`
**Partition:** `packages/master-robots/**`, `worker/scripts/capture-fixture.ts`, new files under `worker/`

Companion to [`2026-09-17-robots-gate-design.md`](./2026-09-17-robots-gate-design.md), which
designed the gate. This one records what happened when it was wired to something real.

---

## 1. What changed

`packages/master-robots` shipped this morning with 76 passing tests and **zero callers**.
`worker/scripts/capture-fixture.ts` now calls it before every capture.

The interesting part is not the wiring; it is that **a green suite over a module nothing
invokes proves the module works, not that the system is protected**. So the new tests in
`worker/test/capture-fixture-gate.test.ts` assert that the *script consults the gate* —
every one of them would still pass inside `packages/master-robots` while the script
happily fetched a forbidden page.

| Before | After |
|---|---|
| A hand-maintained host list was the only robots control | Two gates, both must permit |
| The robots reasoning lived in a comment beside each hostname | The comment is now evidence; the live check is the control |
| Query string stripped *after* the host check | Stripped *before* either gate, so the judged URL is the fetched URL |
| Product token would have been a second hand-typed literal | Derived from `USER_AGENT` via the package's own conversion |
| `worker/scripts/` was outside the worker's `tsconfig.json` `include` | The new test pulls it into the program — it is now typechecked |

---

## 2. Three briefed premises that did not survive recon

Recorded because each one would have produced a worse repo if followed.

### 2.1 "Replace the duplicated `ALLOWED_HOSTS` copy with a call to the gate"

**There was no second copy.** One definition existed, in `capture-fixture.ts`. The two other
repo-wide hits were *comments inside `master-robots`' own tests citing it* — references, not
duplicates. Nothing could drift.

### 2.2 Replacing the list with the gate would have made the script MORE permissive

This is the finding worth keeping. `jobs.lever.co` publishes:

```
User-agent: ClaudeBot
Disallow: /
```

We identify as `applyy-fixture-capture`. That refusal **does not address our token**, so the
live gate selects the `*` group, finds no matching restriction, and returns **ALLOW** — for a
host a human deliberately excluded and wrote a paragraph explaining. `jobs.ashbyhq.com` is
excluded for a reason no robots.txt can express at all: a raw GET is permitted, but *rendering*
the SPA requires fetching disallowed `/api/` paths.

So the two controls answer different questions and neither subsumes the other:

- **Gate one — has a human reviewed this host?** Encodes judgements robots.txt cannot express.
- **Gate two — does the policy permit this path right now?** Catches the one thing a dated
  comment structurally cannot: a policy that changed after a human read it.

Both must permit. The list was renamed `ALLOWED_HOSTS` → `HUMAN_REVIEWED_HOSTS`, because its
meaning changed from *the enforcement point* to *the human-review record*, and a name that
documents a superseded role is worse than no name.

> **A task phrased as "delete the redundant control" deserves more scrutiny than one phrased
> as "add a control", because the cost of being wrong is silent.**

### 2.3 `packages/master-robots` is NOT the unlinked package that makes `pnpm run typecheck` a lockfile writer

The brief warned that a recursive pnpm command would rewrite `pnpm-lock.yaml` because the
lockfile does not yet know about `master-robots`. **It does know** — `pnpm-lock.yaml:83` carries
a full `packages/master-robots:` importers entry with both devDependencies resolved, landed with
`99c42e8`. The hazard described in `CLAUDE.md` §4 is real; this package is no longer an instance
of it. Some *other* unlinked package may still be, so the rule stands — but it should not be
justified by this one.

The command was still not run. The finding does not create permission.

---

## 3. No lockfile write was needed at all

`capture-fixture.ts` imports by **relative path**, not the bare specifier `@applyy/master-robots`:

```ts
import { checkRobots, tokenFromUserAgentHeader } from '../../packages/master-robots/src/index.ts';
```

A bare specifier would require a `worker/package.json` entry, which rewrites the single-owner
lockfile. The relative path costs nothing at install time and is the same technique
`master-robots` itself already uses to reach the shared `Retry-After` parser. Node 24 strips the
types on load, so it runs with no build step and no install — **verified by execution**, not
assumed.

---

## 4. A real bug the new test surfaced within a minute

`worker/tsconfig.json` includes `src/**`, `test/**` and `*.config.ts` — **not `scripts/**`**. So
`capture-fixture.ts` had never been typechecked. Importing it from a test pulled it into the
program, and `tsc` immediately caught:

```
scripts/capture-fixture.ts(146,56): error TS2345:
  Argument of type 'string | null' is not assignable to parameter of type 'string'.
```

`tokenFromUserAgentHeader` returns `string | null` deliberately — it refuses to guess, because a
guessed token silently selects the wildcard group. That makes the null the *caller's* to handle,
and both tempting shortcuts are fail-opens wearing different hats: `!` hands the gate `null` at
runtime, and `?? 'applyy-fixture-capture'` re-types by hand the very string the call exists to
stop duplicating. Fixed by `requireProductToken()`, which throws at load.

**The coverage gap is still open for the rest of `worker/scripts/`** — anything there that no
test imports remains untypechecked.

---

## 5. Verification — literal output

| Gate | Command | Result |
|---|---|---|
| Worker suite | `worker/node_modules/.bin/vitest run` | **17 files, 127 passed, 0 failed** |
| Package suite | `node --test "packages/master-robots/test/**/*.test.ts"` | **76 pass, fail 0**, 17 suites |
| Worker typecheck | `worker/node_modules/.bin/tsc --noEmit` | exit **0** |
| Typecheck non-vacuity | `tsc --noEmit --listFiles \| grep -E "capture-fixture\|master-robots"` | **9 files**, incl. `capture-fixture.ts` and all 7 `master-robots` sources |
| Comment density | source / test | **2.56** / **0.77** (floor ≥1.00 source; observed test band 0.69–0.83) |

### Red-on-revert — the only proof that the tests guard something

Replacing the `checkRobots` call with a hardcoded `allow` turned **5 of 11 red**:

```
× REGRESSION: refuses a reviewed host whose policy now disallows the path
× refuses on 403 rather than reading RFC 9309 "4xx means allow all" as permission
× refuses a soft-200 HTML error page instead of reading it as zero rules
× refuses rather than proceeding when the host asks us to wait
× asks the target origin for its policy and no other
  Tests  5 failed | 6 passed (11)
```

Restored from a scratchpad copy, then re-verified green. No `git stash` — it yanks peers'
in-flight work.

### A vacuous guard I walked into myself

`./node_modules/.bin/tsc --noEmit 2>&1 | tail -20 ; echo "TSC_EXIT=$?"` printed **`TSC_EXIT=0`
while tsc was failing.** `$?` after a pipeline is the exit code of `tail`, not of `tsc`. This is
the same shape as the `deno check | grep -c "^Check"` trap already in `CLAUDE.md` §4 — a guard
that reports success for a reason unrelated to the thing it claims to check. Run the checker
bare and read its own exit code.

---

## 6. Still open

> **Status note, 2026-10-23 (appended; the list below is left as written):** §6.1 is
> closed for the shared transport — commit `111791c` put the gate inside
> `supabase/functions/_shared/http/transport.ts` itself, on by default for every caller,
> failing closed on a soft-200 and on an underivable product token, exactly the
> "one function every Deno fetch path crosses" placement this section recommended.
> The second named site, `scout-ats/index.ts`'s bare `fetch`, is in flight separately.
> Worker-side, the apply page has been gated since `a3b4115`.

1. **No Deno-side production caller.** The gate protects a developer capture script, not the
   pipeline. The two outbound fetch sites are
   `supabase/functions/_shared/http/transport.ts:301` and `supabase/functions/scout-ats/index.ts:249`.
   Both are existing files outside this session's partition, so this was reported rather than
   written. `transport.ts` is the better target — it is the one function every Deno fetch path
   crosses — but it needs care: `master-robots`' own fetcher must not be routed back through a
   gated transport, or the gate recurses fetching its own robots.txt.
2. **`worker/scripts/` is still largely untypechecked** (§4).
3. **`worker/scripts/fixture-server.ts` and the rest of `worker/src/`** were not reviewed for
   ungated outbound fetches; only the capture script was in scope.
