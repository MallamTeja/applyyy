# Audit — the four "pending" claims, checked against the tree

> **Status 2026-11-08:** Superseded. Claim 3 is closed: `normalizer`, `screener` and `scout-ats` all exist as edge functions in `supabase/functions/`. Claim 2 (master resume ingest) was rebuilt as `packages/master-ingest/` with the page routed at `/master-profile` (`apps/web/src/App.tsx:100`); this pass did not re-test the junk-write defect described below. The `/emails` page is still routed (`apps/web/src/App.tsx:90`). Current state: `docs/SYSTEM_ARCHITECTURE.md`. The body below is the original record, unedited.

**Date:** 2026-09-16
**Auditor:** session `applyyy-e0` worker (Parcels E, E2, F)
**Subject:** the four items under *Pending Tasks 🟡* in
[`status/2026-09-11-peer-assignments.md`](../status/2026-09-11-peer-assignments.md)
**Method:** three narrow read-only recon agents, one per claim, plus direct
measurement for the fourth. Every verdict below cites a file and line.

---

## Why this audit exists

A status document that says **pending** for finished work, and stays **silent**
about unfinished work, is worse than no document. It sends the next session to
rebuild something that already exists while the real gap goes unstaffed. Two of
these four claims were wrong in the first direction. One was wrong in *both*
directions at once — listed as pending, partly already built, and hiding a
defect nobody had recorded.

The standing rule this applies: **verify claimed completions, including your
own.** A file EXISTING is not the same as it WORKING. Each claim below was
therefore checked for four separate properties — present, wired, reachable,
tested — because a component nobody renders and a module nobody imports both
look complete in a file listing.

---

## Summary

| # | Claim (as written 2026-09-11) | Recorded | **Actual** |
|---|---|---|---|
| 1 | Email Monitoring page `/emails` | 🟡 Pending | ✅ **DONE** — doc is stale |
| 2 | Master Resume PDF Ingest & Review UI | 🟡 Pending | ⚠️ **PARTIALLY DONE — and actively harmful** |
| 3 | Deploy & wire `screener`, `normalizer`, `scout-ats` | 🟡 Pending | ❌ **Understated.** Two never started; third written but never wired |
| 4 | Pathspec-gated commits & push | 🟡 Pending | ✅ **DONE** |

**The item to act on is #2, not #3.** #3 is a bigger hole but a known one. #2 is
recorded as unbuilt while it is in fact built, reachable, and writing junk into
`master_profiles` on every use.

---

## Claim 1 — Email Monitoring page — ✅ DONE

The doc is stale. This is wired end to end, not merely present.

- Component: `apps/web/src/features/emails/EmailMonitoringPage.tsx` (355 lines) —
  4 KPI cards, search filter, sync drawer, Gmail deep links.
- **Actually routed**, which is the property that distinguishes this from a nav
  entry with no `<Route>`: `apps/web/src/App.tsx:16` imports it, `:47` mounts
  `<Route path="emails" element={<EmailMonitoringPage />} />`, nested inside the
  authenticated `AppShell` (`:35`).
- Queries `email_events` at `EmailMonitoringPage.tsx:83-87` through the anon
  client, protected by the `own email events` RLS policy
  (`20260909235000_rls_policies.sql:151-154`).
- `emailSync.ts` has **three live importers** — not a dead module.
- Tested: `apps/web/test/emailSync.test.ts` (17 cases), plus `e2eSuite.test.ts:388-407`
  which navigates a real browser to `/emails` and asserts 4 stat cards.

**Two deviations from the doc's literal wording**, neither blocking:
1. No `apps/web/src/data/` access layer — the query is inline in the component,
   and relies on RLS alone with no `.eq('user_id', …)` alongside it.
2. Shipped behaviour is **interview-only**. `classification` and
   `classification_confidence` are never surfaced, leaving
   `.email-badge--rejection|--acknowledgement|--unclassified` as dead CSS. The
   doc asked for "classified categories … confidence". That part is genuinely
   unbuilt — a deliberate narrowing documented in the file header, not an
   oversight, but it should not be recorded as delivered.

**Action:** move to Completed, with deviation 2 logged as its own small item.

---

## Claim 2 — Master Resume PDF Ingest — ⚠️ PARTIALLY DONE, and a live data-integrity bug

Both prior readings are wrong. The doc says pending; a spot-check said done.
The chain is *syntactically* connected end to end and *semantically* broken in
three places.

**What is real:** the `<input type="file" accept=".pdf">` exists
(`MasterUploadReview.tsx:386-397`), calls `handleFileUpload` (`:270-292`), which
calls `extractPdf` (`:277`); the component is mounted via `MasterProfilePage`
(`App.tsx:50`). `storeMasterProfile` (`masterStore.ts:303-339`) is correct and
is not the break.

**The breaks:**

| # | Break | Location |
|---|---|---|
| 1 | `extractPdf` never reads `pdfBytes`; returns a hardcoded placeholder | `pdfExtractor.ts:27-46` |
| 2 | `@applyy/master-pdf` is not in `apps/web` deps, not linked in `node_modules` — the dynamic import always throws | `apps/web/package.json:14-21` |
| 3 | That package exports no `extractPdf`; the real `extract.ts` / `extractProfile` was never written | `packages/master-pdf/src/index.ts:26, 40-56` |
| 4 | An empty `catch {}` turns both failures into a silent success | `pdfExtractor.ts:23-25` |
| 5 | Upload stores the **unreconciled** profile | `MasterUploadReview.tsx:283` |
| 6 | Upload writes to the DB **before** the acknowledgement gate | `:281-286` vs `:313` |
| 7 | No `masterIngest` validation on PDF-derived profiles | paste path only |
| 8 | Zero tests — no file under `apps/web/test/` mentions PDF upload | — |

**Observable behaviour today:** upload any PDF → UI reports success → a profile
named `"Extracted Candidate"` with empty experience, projects and skills is
written to `master_profiles` as a new version, unreconciled and unreviewed.

**Breaks 5 and 6 are the serious ones**, and they are worse than the missing
parser. `MasterUploadReview.tsx:348-353` contains this comment about the
*correct* path:

> "THE RECONCILED PROFILE, NOT THE INCOMING ONE. This is the single most
> important line in the file… Storing `incoming` would re-identify every node
> and silently break every pinned application."

`handleFileUpload` at `:283` commits exactly that mistake, seventy lines above
the warning against it, and bypasses the entire review gate the component's
47-line header exists to justify.

**This is the single most instructive finding in the audit.** The invariant was
known, written down, and defended on one code path — and a second path added
later walked straight around it. A comment is not a control
([`verification-traps.md` §19](../verification-traps.md)). The protection lived
in prose next to one call site rather than in `storeMasterProfile`, which is the
one place both paths pass through.

**Re-scope the task.** It is no longer "connect the input" — that is done. It is:
implement `extractProfile` in `packages/master-pdf/src/extract.ts`; declare the
dependency; delete the silent fallback; and route the upload through
`reconcileMasterProfile` + the acknowledgement gate instead of writing directly.

**Check before anything else:** if anyone has used that input against a
configured Supabase, `master_profiles` already holds junk versions.

---

## Claim 3 — `screener` / `normalizer` / `scout-ats` — ❌ understated

`supabase/functions/` contains exactly three function directories:
`email-tracker-intake`, `rls-proof`, `scout-ats`. No `screener`, no
`normalizer` — confirmed absent from disk, from `git stash list` (empty), from
`.github/workflows/`, from `supabase/config.toml`, and from every deploy script.

**The consequence is more severe than "two deploys outstanding".** From
`20260909234900_status_transition_guard.sql:99-108`, these are the *complete*
outgoing edge sets:

```sql
('discovered', 'deduped',           array['normalizer']),
('discovered', 'dropped_duplicate', array['normalizer']),
('discovered', 'failed',            array['normalizer','human']),
('deduped',    'passed_filters',    array['screener']),
('deduped',    'dropped_filter',    array['screener','human']),
('deduped',    'failed',            array['screener','human']),
```

1. **`discovered` is a hard stop.** Every forward exit requires `normalizer`;
   the only non-normalizer edge is `human → failed`, a dead end. Since scout
   creates rows *at* `discovered`, **100% of discovered inventory is terminal.**
2. **`deduped` is a second wall.** Its only forward edge is machine-only —
   `array['screener']`, no `'human'` — so even a hand-deduped row cannot advance.

These two agents own **the only two forward edges in the graph that are
machine-only with no human fallback.** This is a total pipeline severance at the
first hop, not a slow stage.

**The groundwork is done; only the entrypoints are missing.** `_shared/filter/cascade.ts:357`
(`screenJob`) and `_shared/normalize/{fingerprint,posted-at}.ts` are complete and
tested; `_shared/agent/loop.ts` is the shared stage runner; `_shared/agent/batch.ts:40,44`
already allocates batch sizes for both. This is the last 10–15% of each, not a
greenfield build.

**Three things nobody had recorded:**

- `supabase/functions/_shared/screen/` exists on disk and is **empty**. Git does
  not track empty directories, so it is invisible to every clone — a scaffold
  folder that looks like progress locally and does not exist to anyone else.
- **It fails invisibly, not loudly.** No workflow references either function, so
  there is no red X anywhere. `scout.yml` runs `cron: '0 */6 * * *'` and invokes
  the **worker CLI**, not the Edge Function. The only symptom is fresh
  `discovered` rows appended to a queue with no consumer, four times a day,
  forever. The health page cannot flag it either: a stage with no `agent_runs`
  rows looks identical to a stage that was never scheduled.
- **`scout-ats` is written but not wired.** The status item says "deploy **and
  wire**". Nothing calls the Edge Function — no cron, no `pg_net`, no workflow.

**The gap is wider than the doc states:** `matcher`, `tailor`, `auditor`,
`sweeper` and `tracker` have no entrypoint either. `screener`/`normalizer` is
simply the first hole a row falls into.

### Pre-existing security finding, surfaced by this claim

`DiscoveredJobsPage.tsx:234-250` (in HEAD, committed) works around the missing
agents by walking the pipeline client-side, declaring `agent: 'normalizer'`,
`'screener'`, `'matcher'` in turn. This is accepted because
`advance_application_status` (`20260909235100_queue_and_pool_functions.sql:111-127`)
takes `p_agent` as an **unverified caller-supplied parameter** and
`set_config`s it. The guard validates a *claimed* identity, never an
authenticated one.

So a browser session can name any agent — including `'applier'` for
`approved → applying`, the single non-idempotent edge in the graph — and the
resulting `application_events` rows attribute work to agents that do not exist.

**Needs a human decision, not a patch.** The fix is a change to the RPC
contract, which is a design call about how agent identity is established.

---

## Claim 4 — pathspec-gated commits & push — ✅ DONE

28 commits since 2026-09-11; `git log origin/main..HEAD` is **empty**, so
nothing is stranded locally. Peer 1's work is in (`5c1c320`
`fix(master-pdf): handle item gap spacing…`), as is Peer 3's. No evidence of any
`git add -A` incident since the 2026-09-10 loss of 392 `PROJECT_PLAN` lines.

---

## Cross-cutting finding: two verification routes, and a green from one says nothing about the other

Recorded here because it is exactly the kind of thing a future session assumes
wrongly, and the assumption is invisible when it is wrong.

| Route | Covers | Does **not** cover |
|---|---|---|
| `pnpm run typecheck` | the 6 pnpm workspace projects | **the entire Deno tree** |
| `cd supabase/functions && deno check` | `_shared/**`, the function entrypoints | everything else |

`supabase/functions` is deliberately not a pnpm workspace member — it is a Deno
project with its own `deno.json`, and adding a `package.json` would put two
dependency managers over one directory. A clean `pnpm run typecheck` therefore
says **nothing whatsoever** about `supabase/functions/**`.

### And a measurement trap found while running these checks

`pnpm run typecheck` uses `pnpm -r`, which **fail-fasts**. On 2026-09-16 the
worker project failed with 4 errors and `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`
aborted the run — so `apps/web` never reported at all, and three pre-existing
errors in `ApprovalQueuePage.tsx` were invisible in the output. They surfaced
only once worker was fixed, which reads misleadingly like the fix caused them.

Same family as [`verification-traps.md` §19](../verification-traps.md): ordering
inside a fail-fast chain decides what you still learn on a bad day. **When
reading a recursive-run result, check whether every project actually reported
before treating the listed errors as the complete set.**

### The deploy consequence, which is the highest-priority item in this document

`apps/web`'s build script is `tsc --noEmit && vite build`, and `vercel.json`
sets no `buildCommand` override. Measured separately on 2026-09-16:

```
./node_modules/.bin/tsc --noEmit   -> EXIT 2 (3 errors, all ApprovalQueuePage.tsx)
./node_modules/.bin/vite build     -> EXIT 0, 177 modules, built in 2.86s
```

Vite is healthy. The `tsc` gate is red, `&&` short-circuits, `vite build` never
runs, and the deploy produces no output — so **production is serving a stale
bundle and has been since those errors appeared.** Committed fixes are not
reaching `applyyy.vercel.app`, which is the actual reason the tech-only
filtering committed in `ab05ba4` is not visible to the user on the live site.

The three errors are pre-existing and small:

```
ApprovalQueuePage.tsx(40,1)  TS6133  'ClaimDecision' is declared but never read
ApprovalQueuePage.tsx(49,9)  TS6133  'toast' is declared but never read
ApprovalQueuePage.tsx(78,15) TS2322  MasterProfile: property 'links' missing
```

Not fixed here — `ApprovalQueuePage.tsx` was outside this session's write
partition. **This unblocks every stream's deploy, not one bug, and should be
taken before any further feature work.**

---

## What this audit does NOT establish

Stated explicitly, because an audit that omits its own limits invites the
over-reading it was written to prevent.

- **Nothing was executed against a live database.** Every schema claim is read
  from migration files. Per [`verification-traps.md` §11], files and the live
  database can disagree silently while any migration has an empty `remote`
  entry — read the files for intent, query the database for behaviour.
- **The `/emails` e2e assertions were read, not run.** They exist and are
  un-skipped; that is not the same as currently green.
- **Claim 2's breaks were traced statically.** No PDF was uploaded, so whether
  `master_profiles` already holds junk rows is unconfirmed and worth checking
  directly.
- **`supabase/functions` test results on 2026-09-16 are contaminated.** A
  concurrent session was mid-write in `_shared/match/` and `_shared/http/`
  (both untracked, created 23:10 during this audit). The suite reports 288
  tests / 1 failure; that failure is `salary-gate.test.ts` importing a
  `salary-gate.ts` that does not exist yet. **It is in-flight work, not a
  broken baseline, and must not be "fixed" out from under its author.**
