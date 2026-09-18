# Progress against the product goal — 2026-09-18

**Measured:** 2026-09-18, ~13:05 IST, session `applyyy-5d`, HEAD `3c09f54`.
**Question asked:** *how far is `applyyy` from the ideal product?*
**Method:** every stage verdict below was re-measured today by this session — live DB via the
Supabase CLI, live production bundle over HTTPS, repo-wide grep, and both test suites run to
completion. No verdict is inherited from a doc.

**Companion document:** [`../audit/2026-09-18-pending-work-reverified.md`](../audit/2026-09-18-pending-work-reverified.md)
(session `applyyy-b0`, same morning) re-verifies the **task list** T1–T24. This document is the
**product** view: how much of the loop the user actually gets. The two were derived independently
and agree everywhere they overlap, which is why the shared conclusions below are stated flatly.

---

## 1. The one-paragraph answer

**The two ends of the pipeline are built and the middle is severed.** Discovery works and is
production-reachable; the Playwright applier is built, tested and wired to a workflow; the
dashboard, schema, RLS and auth are all real. But **no job has ever traversed the loop end to
end**, and none can today, because the three agents in the middle — Matcher, Tailor, Auditor —
are respectively unwired, unwired, and **not written at all**. The honest headline is *a
well-built machine with its driveshaft missing*, not *a nearly-finished product*.

Against `PROJECT_PLAN.md` §1's definition — *discover → score → tailor → audit → approve →
submit → track* — **stages 1 and 5–7 exist, stages 2–4 do not connect.**

---

## 2. Stage-by-stage against the Phase-1 loop

`PROJECT_PLAN.md` §20 defines Phase 1 as "the loop". Scored against that, not against the
optional Phase 2/3 features, which are correctly deferred and should stay deferred.

| # | Stage | State | Evidence measured today |
|---|---|---|---|
| 0 | **Schema, RLS, auth, migrations** | **Done** | 18 local migrations, **15 applied to the live remote**, 3 pending — `supabase migration list`, exit 0 |
| 1 | **Master profile ingest** | **Broken, unconditionally** | `pdfExtractor.ts:14` probes `mod.extractPdf`, a symbol present nowhere in `master-pdf`; the package is not even a dependency of `apps/web`; `catch {}` at `:23` swallows both. **Every upload returns the hardcoded `Extracted Candidate` profile** |
| 2 | **Discovery (Scout)** | **Done and reachable** | `supabase/functions/scout-ats/` + `worker/src/cli/scout.ts`; Greenhouse / Lever / Ashby adapters; `scout.yml` runs 4×/day |
| 3 | **Dedupe (Normalizer)** | **Helpers done, runner missing** | `_shared/normalize/` exists and is production-reachable (`fingerprint.ts`, `posted-at.ts`). **Nothing writes status `deduped`.** This is "wire a runner", not "write an agent" |
| 4 | **Filter cascade (Screener)** | **Code done, config empty** | `screenJob` is reachable via `_shared/screen/screen-batch.ts`. But `filter_rules` is empty and unconfigurable for three independent reasons; two rules can never fire |
| 5 | **Matcher (score)** | **Written, NOT WIRED** | `grep` for non-test importers of `_shared/match/`: **zero results** |
| 6 | **Tailor (rewrite)** | **Written, NOT WIRED** | Same: zero non-test importers of `_shared/tailor/`. And **nothing anywhere writes `tailored_profile`** — grep for insert/update/upsert against that column returns nothing |
| 7 | **Auditor (anti-fabrication)** | **DOES NOT EXIST** | `ls supabase/functions/_shared/` — there is no `audit*` directory. 15 directories, none of them the Auditor |
| 8 | **Approval queue** | **Works, but empty by construction** | `settle()` calls `advance_application_status` with `p_agent:'human'`. The queue refuses any row with a null `tailored_profile` — and nothing produces one. **100% of arrivals are refused** |
| 9 | **Applier (Playwright)** | **Built, never fired for real** | `worker/src/cli/apply.ts`, **127 tests green**; `apply.yml` daily 08:00 IST with `dry_run` defaulting to `true` |
| 10 | **Email tracker** | **Scaffolded** | `supabase/functions/email-tracker-intake/` exists |
| 11 | **Dashboard / kanban / health** | **Done and deployed** | 7 feature areas: `approval`, `auth`, `discovery`, `emails`, `health`, `pipeline`, `settings` |

### The structural blocker behind stages 3–5

`status_transition_guard.sql:101-103` seeds exactly three edges out of `discovered`: `deduped`,
`dropped_duplicate`, `failed`. The Screener's only legal source is `deduped`, **which nothing
writes**. So rows sitting at `discovered` are **stranded permanently** — this is a hole in the
state graph, not a missing agent, and any plan to "wire the Matcher" must answer for the existing
inventory first.

---

## 3. Three blocking questions answered today

All three had been open since 2026-09-17 and were listed as needing Teja.

### T3 — "is production stale?" — **NO. Production is CURRENT.** *(answered here first)*

The peer audit's §4 correctly reasoned this *might* be answerable; this session went and did it,
with a plain HTTPS fetch and no Vercel CLI:

```sh
curl -s https://applyyy.vercel.app/ -o idx.html                 # HTTP 200
grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' idx.html            # -> /assets/index-Ba-KNQiA.js
curl -s https://applyyy.vercel.app/assets/index-Ba-KNQiA.js -o app.js   # 532,579 bytes
grep -c "Nothing compared these against your master profile" app.js     # -> 1   PRESENT
grep -c "Fast-tailored and queued from Discovered Jobs Explorer" app.js # -> 0   ABSENT
```

**Both sentinels agree:** the post-deletion copy is live *and* the forged fast-path button is
gone from production. The four-day-stale-deploy fear is closed. **Note the method — the Vercel
CLI was never the only way to answer this; a public bundle is readable by anyone.**

### T1 — "no session can see the live database" — **FALSE**

`supabase migration list` ran non-interactively, exit 0, first attempt. The **MCP connector** is
unauthenticated; the **CLI** is authenticated and linked. Two different things share the name
"Supabase", and `CLAUDE.md` collapses them into a claim that has been wrong for a day.
**Teja's own memory file already recorded this correctly — the repo docs never picked it up.**

### T2 — the migration backlog is **THREE**, not eight or seven

15 of 18 applied. The three pending are exactly the three that have been reviewed
(`20260917124500`, `20260917130000`, `20260917174600`). **The five files RESUME-HERE told us to
watch nervously are already on the remote** — including `20260910220800`, whose `create policy`
re-run hazard was the reason for the one-second pre-flight. That pre-flight is now **moot**: the
file is applied, and `db push` will skip it.

---

## 4. Verification state — what is actually green

| Suite | Result |
|---|---|
| Node suites (`supabase/functions`, `packages/**`, `apps/web`) | **984 pass, 0 fail**, 90 suites |
| Worker (vitest) | **127 pass, 0 fail**, 17 files |
| **Total** | **1,111 passing, zero failures** |
| `deno check --reload` on the two flagged files | **RED — "Found 4 errors"**, unchanged since 09-12 |

Counts date-stamp themselves; only `fail 0` compares across sessions.

**A trap worth recording:** `node --test worker/test/**` reports every worker test as **failed**.
That is not breakage — `worker` uses **vitest** (`worker/package.json:15`), and importing vitest
outside its runner throws *"Vitest failed to access its internal state."* This session walked into
it and nearly reported a red worker suite. **The repo has two test runners and the wrong one fails
loudly in a way that reads like real breakage.**

---

## 5. So how far along is it?

Counting by **component**, the project looks ~75% done: schema, auth, RLS, dashboard, discovery,
screener, applier and CI all exist and are tested.

Counting by **the user's actual outcome — an application submitted to a real job** — it is **0%**,
because the chain has three consecutive breaks and a chain does not partially conduct.

Both numbers are true and the second is the one that matters. The gap between them is the single
most important fact about this project's status, and it is exactly the shape `CLAUDE.md` §8 warns
about: **do not assume a module runs because it has tests.**

### The shortest path to a first real application

1. **Fix master-profile ingest** (3 separate fixes, not 1) — nothing downstream can be correct
   while every profile is the hardcoded placeholder. **This is the true root of the chain.**
2. **Add the `discovered → passed_filters` edge** (a migration) — unstrands the existing backlog.
3. **Wire a Normalizer runner** around the existing tested helpers — small, not an agent build.
4. **Wire Matcher → Tailor** so something finally writes `tailored_profile`.
5. **Write the Auditor** — the only genuinely absent agent, and the honesty gate the whole
   design rests on.
6. **Harden the approval gate** to a shape check, and delete the dead fallback behind it.
7. **One real application, watched**, via `apply.yml` `workflow_dispatch` — `dry_run` first.

Steps 1–4 are each small. **Step 5 is the real remaining build.**

---

## 6. What this measurement is an instance of

Four documents carried four different migration counts and all four were wrong; the top-ranked
blocker was not a blocker; the deploy question that cost two agents an afternoon was answerable
with `curl`. The common thread is **a fact recorded once and then relayed instead of re-measured**.

The rule that would have caught every one of them is already in `CLAUDE.md` §4: *any inventory
that can drift must point at the command that regenerates it, never at the list alone.* Each
verdict in this document is therefore paired with the command that reproduces it.
