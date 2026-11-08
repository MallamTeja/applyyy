# Handoff verification — `applyyy-9f` → this session, 2026-09-10 21:05 IST

> **Status 2026-11-08:** Historical. Every claim describes the repo and Vercel on 2026-09-10. Since then the duplicate `apps/web/vercel.json` was deleted (`d0eaa7f`, 2026-10-24), so the root `vercel.json` is the only config; `.playwright-mcp/` is still gitignored (`.gitignore:64`). The method (verify a handoff against the artifact) now lives in `CLAUDE.md` section 2. The body below is the original record, unedited.

`applyyy-9f` transferred orchestration in three messages before its session was
closed. This document records what happened when each load-bearing claim in that
handoff was checked against the artifact rather than accepted.

The peer's own closing instruction was **"derive from the artifact, not from a
relayed summary — including mine."** This is that pass. **Two** of its claims did
not survive, and one of the two was its stated top priority. A third thing I
reported as false turned out to be true and the error was mine — §3, kept in
full because the mistake is more instructive than the finding would have been.

Method note: every check below is read-only and reproducible from the commands
quoted. Nothing here rests on a report from another agent, which is the failure
mode the exercise exists to catch.

---

## Summary table

| # | Handoff claim | Verdict | Evidence |
|---|---|---|---|
| 1 | "Vercel: **STILL FAILING**, your most immediate task" | **FALSE — already green** | `e8ac631` deployed `READY` at 15:29:30Z |
| 2 | "Four subagents running; their **file changes persist on disk**" | **TRUE — I was wrong** | tree empty at 21:06, writing by 21:11; see §3 |
| 3 | "`.playwright-mcp/` is NOT yet gitignored" | **FALSE — already ignored** | `.gitignore` carries it with a 9-line rationale |
| 4 | "GitHub fully pushed, HEAD `e8ac631`" | **TRUE** | `git log origin/main..HEAD` empty |
| 5 | "Duplicate `vercel.json`, the `apps/web` one is dead" | **TRUE** | both present, root-only `outputDirectory` |
| — | *(not in the handoff)* | **NEW DEFECT** | **zero env vars on the Vercel project** |

---

## 1. The Vercel deploy is green, not failing

The handoff was written while the deploy was still in flight and never updated.

```
2026-09-10T15:29:30Z READY  applyyy-g3fj08xs1-…  target=production  src=e8ac631
2026-09-10T15:26:15Z ERROR  …                     src=ff98e3a
2026-09-10T13:42:25Z ERROR  …                     src=21f0701
```

Both of the peer's fixes worked: `build: pnpm -r --if-present run build` cleared
the `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT` failure, and the root `vercel.json`
pointed the output at `apps/web/dist`.

`READY` alone is not proof the site works, so it was checked end to end:

- `GET /` → `200`, serves the real `index.html` (`<title>applyy — application console</title>`)
- `GET /settings/health` → `200`, so **the SPA rewrite is live** (a 404 here is
  what a missing rewrite looks like)
- All four security headers present, including the full CSP with the Supabase
  origin allow-listed

That closes the read-only recon task whose findings were lost with the peer's
session.

---

## 2. THE NEW DEFECT — the site is live and cannot reach its database

**The Vercel project has zero environment variables configured.**

```
GET /v9/projects/applyyy/env  →  *** ZERO environment variables configured ***
```

So `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` were undefined at build
time, and the production bundle contains no Supabase credentials. Confirmed
directly against the deployed asset — not against a local build, because a local
build proves nothing about what Vercel actually shipped:

```
/assets/index-CElyW-ST.js   346,180 bytes
JWT-shaped tokens found:    0
```

**This scan was checked for vacuity before being believed**, per
`verification-traps.md` Instance 13. A regex that matches nothing and a regex
that is broken produce identical output:

- *positive control* — the same pattern against a synthetic `eyJ…` JWT → **1 match**
- *non-vacuity* — the bundle is 346 KB, so a real artifact was scanned
- *presence check* — `VITE_SUPABASE_ANON_KEY` appears 4× in the bundle **as a
  literal string**, i.e. only inside the guard's own error messages. Vite
  substitutes `import.meta.env.*` at build time; the variable name surviving as
  text is the signature of a value that was never provided.

So the finding is genuinely "no key was injected", not "the scan missed it".

**Silver lining, and it is a real one:** the anon-key guard built earlier today
is doing exactly its job. This is not a leak — nothing secret shipped. It is the
opposite failure, and it is the safe direction to fail in.

**Consequence:** `applyyy.vercel.app` renders its shell and every data-backed
page is inert. Anyone opening it would read this as "the app is broken", not as
"an env var is missing". Setting the two `VITE_*` variables and redeploying is
the fix; the anon key is safe to expose by design (§ the frontend gets the anon
key only and relies on RLS) — **which is precisely why §3's unproven RLS is the
blocker standing behind this one.**

---

## 3. The subagents DID write — and how I got this wrong

**This section originally claimed the four subagents produced no files. That was
wrong, and the way it was wrong is worth more than the finding would have been.**

At 21:06 the measurement was real:

```
git status --short  ->  0 lines   (snapshot 1)
git status --short  ->  0 lines   (snapshot 2, taken later)
normalizer screener matcher tailor auditor  ->  ABSENT (all five)
find -newermt '2026-09-10 19:10'  ->  only .remember/ bookkeeping
```

By 21:11 the same command returned:

```
 M apps/web/src/app/AppShell.tsx
 M apps/web/src/data/humanLanes.ts
 M apps/web/src/features/health/HealthPage.tsx
?? apps/web/src/data/agentFreshness.ts
?? apps/web/src/data/useAgentRuns.ts
?? supabase/functions/_shared/agent/
```

The agents were alive the whole time. They had simply not reached their first
write yet.

### The trap, and it is a new instance for `verification-traps.md`

The peer's instruction was sound on its face: *"`git status --short` twice, a
little apart; if those paths stop changing, the agents are done."* I followed it
exactly and it produced a confident false conclusion, because:

**A stability check cannot distinguish "finished" from "not started."** Both
present as an unchanging tree. Two identical readings feel like corroboration
and are not — they are the same measurement taken twice, and neither one can
see a process that has produced nothing so far.

Worse, the reading was **doubly** vacuous: I then reached for
`find -newermt 19:10` as independent corroboration, but it interrogates the same
underlying fact (no writes yet) through a second interface. Two views of one
absence is still one observation. *Corroboration requires an independent signal,
not a second window onto the same one* — which is `verification-traps.md`'s own
rule about silence being indistinguishable from "checked nothing", arriving here
through a door I did not recognise.

**What would actually have discriminated:** asking whether the *producers* are
alive, not whether the *product* exists. `ListAgents`, or a process check —
positive evidence of an agent running beats any amount of negative evidence
about its output. An idle tree plus a live agent means "wait"; an idle tree plus
no agent means "nothing came". Only the second reading licenses the conclusion I
drew.

**Standing correction for this repo:** never conclude a background worker is
finished from the absence of its output. Confirm the worker itself is gone.

### What is actually on disk (as of 21:13, and it may still be growing)

- `apps/web/**` — health-panel work: `agentFreshness.ts`, `useAgentRuns.ts`, and
  edits to `AppShell.tsx`, `humanLanes.ts`, `HealthPage.tsx`
- `supabase/functions/_shared/agent/` — new shared agent scaffolding
- The five named §7 function directories (`normalizer`, `screener`, `matcher`,
  `tailor`, `auditor`) are **still absent**, so that agent is mid-flight rather
  than finished

None of it is reviewed, and per the peer's own instruction it must be treated as
untrusted work: typecheck, build, full test run, mutation-test every guard, and
a comment-every-line check before any of it is staged.

## 4. Confirmed as stated

- **Pushed.** `git log origin/main..HEAD` is empty; HEAD is `e8ac631` on
  `origin/main` at `github.com/MallamTeja/applyyy`.
- **Duplicate `vercel.json`.** Root and `apps/web/` are byte-identical except
  the root's `outputDirectory`. Vercel treats the repo root as project root, so
  `apps/web/vercel.json` is inert. Deleting it needs Teja's OK (gate on
  destructive work) — but note the drift is live *today*: an editor of the dead
  file would see their CSP change do nothing. **Resolved 2026-10-24:** deleted with
  Teja's OK; the one test that read it by path now checks the root file only.
- **`.playwright-mcp/` is already gitignored**, with a rationale comment
  explaining the write-into-tree + `git add -A` combination. Listed as
  outstanding in the handoff; it is done.

---

## 5. Index correction made while here

`docs/README.md` described `verification-traps.md` as "Six instances". It
documents **14**. Corrected in place.

A stale count is minor on its own; it is recorded because that index's own
header warns that duplicated facts drift and then contradict each other, and
this is that warning coming true in the file that issues it.

---

## What this changes about priority order

The handoff's order was: Vercel deploy → `.playwright-mcp/` → `vercel.json` →
advisories. Items 1 and 2 are done, so the real order is:

1. ~~Set the two `VITE_*` env vars on Vercel and redeploy~~ — **DONE 21:12**,
   see §6.
2. **RLS proof** (blocked on Teja: two Auth users). Unchanged as top risk, and
   it now gates item 1's safety story as well, since the anon key is only safe
   *because* RLS is assumed to scope.
3. **Review the in-flight subagent output** in `apps/web/**` and
   `supabase/functions/**` once those paths settle (§3). The five §7 function
   directories are still absent.
4. `vercel.json` consolidation (needs Teja's OK), then the 43 advisories.

---

## 6. The env-var fix, applied 21:12 IST

Teja authorised the fix directly and asked for it via the Vercel CLI.

**What was done.** The anon key was read from Supabase
(`supabase projects api-keys`), its `role` claim decoded and asserted to be
`anon` *before* it was sent anywhere — a paste of the service-role key is the one
mistake here that cannot be walked back once it is in a public bundle. Then
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` were set on all three targets
and `e8ac631` was redeployed.

**Deliberate choice: `vercel redeploy <url>`, not `vercel --prod`.** A plain
`vercel --prod` uploads the *local working tree*, which at that moment held
unreviewed in-flight subagent work (§3). `redeploy` rebuilds the committed,
pushed `e8ac631` with the new environment. **The env-var fix and the agent work
had to reach production separately or not at all** — bundling them would have
shipped unreviewed code under cover of a config change.

**A platform guard worth knowing about.** Vercel rejected the first four
attempts:

> *Environment variables with a public framework prefix (VITE) cannot use secret
> visibility on Production or Preview.*

New variables default to sensitive, and Vercel refuses that for a `VITE_`
prefix, because that prefix means the value is inlined into the client bundle —
so calling it secret would be a false assurance. `--no-sensitive` is the correct
flag. This is a well-designed guard: it fails closed on a lie about a value's
exposure, and it is worth remembering as the reason the obvious command fails.

**Verified after the fact, against the live bundle rather than the build log:**

| Check | Result |
|---|---|
| Asset hash changed (`index-CElyW-ST` → `index-DjZASR6a`) | **real rebuild, not a cache replay** |
| JWTs in bundle, role claim decoded | exactly one, `"role":"anon"` |
| `service_role` occurrences | **0** |
| Supabase project URL present | yes |
| Regex positive control | 1 match — the scan can detect what it looks for |

The asset-hash comparison is the non-vacuity twin for the redeploy itself: an
unchanged hash would mean Vercel served the old artifact and every other check
below it would have been measuring the previous build.

**Side effect cleaned up.** `vercel link` appended `.vercel` and `.env*` to
`.gitignore`. Both duplicate existing rules, and `.env*` is *broader* than the
existing `.env` / `.env.*` / `!.env.example` block in a way that conflicts with
the deliberate negation. Reverted. `.env.local`, also created by `link`, is
already covered by `.env.*` and is left in place.
