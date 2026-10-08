> **Historical record as of 2026-09-17.** Current state: [SYSTEM_ARCHITECTURE.md](../SYSTEM_ARCHITECTURE.md) · [PROGRESS.md](../PROGRESS.md).

# Pending-work audit — 2026-09-17

**Written by `applyyy-92` (a coordinating session, not the partition-map holder).
Measured between 16:56 and 17:45 IST on 2026-09-17. HEAD moved six times during the pass.**

This answers three questions, kept separate on purpose because they have different
half-lives: **what is left**, **what is broken**, and **what was planned and is not
there**. A fourth section records what *no session can check from this machine*, so a
later reader does not mistake an un-run check for a passed one.

## How to read this

Every claim carries `file:line`. Where a figure is a measurement it carries a
**timestamp**, because in this repo a count is a measurement at an instant and not a
property of the tree — five sessions land work while you read.

**This document ages.** It is accurate as of `571fe74`. Re-derive anything load-bearing
before acting on it; that instruction is not politeness, it is the lesson of §7.

---

## 1. The headline

**A job discovered today reaches `passed_filters` and stops.**

Two of the eight designed pipeline stages run in production. One more exists as a
dashboard screen with a correct write path and no supply. Five stages are either
unreachable code or were never written.

As of `75a75a0` (17:10 today) the manual bypass that papered over this is deleted, so the
severance is now total and visible rather than total and disguised.

---

## 2. Pipeline wiring — stage by stage

| # | Stage | Exists? | Runs in production? | Writes |
|---|---|---|---|---|
| 1 | **Scout** | yes, three | **YES** — cron `0 */6 * * *` at `.github/workflows/scout.yml:8` → `worker/src/cli/scout.ts`; plus dashboard-invoked `scout-ats` (`apps/web/src/data/discoveryService.ts:422` → `supabase/functions/scout-ats/index.ts:56`) | `discovered`, `passed_filters`, `dropped_filter` |
| 2 | **Screener** | yes | **YES**, since `042bc78` — `_shared/filter/cascade.ts` `screenJob`, called at `_shared/screen/screen-batch.ts:194`, imported by both live scouts (`scout-ats/index.ts:16`, `worker/src/cli/scout.ts:17`) | inserts rows *born at* `passed_filters` / `dropped_filter` |
| 3 | **Matcher** | modules only | **NO** — `_shared/match/{prompt,rubric,salary-gate,scorer}.ts` have **zero non-test importers**; no `supabase/functions/matcher/` | nothing |
| 4 | **Tailor** | modules only | **NO** — `_shared/tailor/` zero non-test importers | nothing |
| 5 | **Auditor** | **does not exist** | **NO** — there is no `_shared/audit*` directory at all. The name appears only in the enum, the graph edges, a batch-size constant and the health page | nothing |
| 6 | **Human approval** | yes | **YES** — live route; `ApprovalQueuePage.tsx:374` calls `advance_application_status` with `p_agent:'human'`, and only removes rows the DB accepted | `approved`, `dropped_filter` |
| 7 | **Worker submit** | yes | **YES** on cron `30 2 * * *` (`.github/workflows/apply.yml:34`) — but `DRY_RUN` hard-defaults to `'true'` (`apply.yml:66`), and it claims only `approved` rows (`worker/src/supabase-gateway.ts:141-144`), of which there are none | `applying`, `applied`, `blocked_needs_human` |
| 8 | **Email tracker** | **intake only** | partially — `email-tracker-intake/index.ts` stores mail and explicitly does not classify (`index.ts:8`). No classifier exists anywhere | `email_events` only; never touches `applications` |

### Where the chain breaks, in order

1. **`passed_filters` → `scored`.** No Matcher agent. A row at `passed_filters` is read by
   nothing, ever. **This is the wall.**
2. **`scored` → `tailored`.** No Tailor agent. Unreachable anyway.
3. **`tailored` → `audit_clean` → `awaiting_approval`.** No Auditor at all. The Auditor owns
   *both* edges into `awaiting_approval` (`status_transition_guard.sql:126-127`), so the
   approval queue has no legitimate supply by construction.
4. **`applied` → tracker statuses.** Mail lands in a table nothing reads.

---

## 3. The structural finding: a hole in the graph, not a missing agent

`supabase/migrations/20260909234900_status_transition_guard.sql:101-103` seeds **exactly
three edges out of `discovered`**:

```
discovered -> deduped            [normalizer]
discovered -> dropped_duplicate  [normalizer]
discovered -> failed             [normalizer, human]
```

**There is no `discovered → passed_filters` edge.** The Screener's only legal source state
is `deduped`, and **nothing in this repo writes `deduped`**. Both call sites already
document working around this by *inserting* rows at their verdict rather than transitioning
them — `_shared/screen/screen-batch.ts:148` and `supabase/functions/scout-ats/index.ts:375`.

That workaround is sound for *new* jobs. The consequence nobody had stated:

> **Every application row already sitting at `discovered` is permanently unscreenable.**
> `ignoreDuplicates: true` on the applications upsert (`scout.ts:317`,
> `scout-ats/index.ts:407`) means an existing row is never touched, and no legal edge
> carries it forward.

So "wire up the Matcher" is not the whole job. The stranded backlog needs either a
Normalizer runner or a new seeded edge, and that decision comes **before** the Matcher, not
after it.

**Naming precision that matters for sizing the work:** `_shared/normalize/` **does exist and
is production-reachable** — `fingerprint.ts` and `posted-at.ts`, imported by
`_shared/ats/registry.ts:25,27` and `_shared/scout/tiers.ts:20,21`. What is missing is a
Normalizer **runner** that writes the `deduped` status. Wiring a runner around tested
helpers and writing an agent from scratch are very different amounts of work; earlier
reports conflated them.

---

## 4. Status coverage — 21 allowed, 8 written

| Bucket | Count | Statuses |
|---|---|---|
| Written by automation | 8 | `discovered`, `passed_filters`, `dropped_filter`, `approved`, `applying`, `applied`, `blocked_needs_human`, `needs_verification` |
| **Written by nothing at all** | **13** | `deduped`, `scored`, `tailored`, `audit_clean`, `awaiting_approval`, `audit_flagged`, `dropped_duplicate`, `employer_screening`, `oa_pending`, `interview`, `offer`, `rejected`, `failed` |

The first five of that second group had exactly one writer until 17:10 today — the
"Tailor & Queue" ladder — and **zero** since `75a75a0` deleted it. Verified at `571fe74`:
the only remaining `awaiting_approval` reference outside tests is a `.eq()` **read** at
`ApprovalQueuePage.tsx:166`.

**The approval queue is now correct, well-written, and structurally guaranteed to be empty.**
That is the honest state, and it is an improvement: it previously received a 100% forged
supply that the `629dc81` gate refused anyway.

---

## 5. What is broken — ranked by consequence

### 5.1 Every master-resume PDF upload silently returns a fake profile

`apps/web/src/features/settings/pdfExtractor.ts:14-25`. **Three independent breaks, one
silencer:**

1. The function is itself named `extractPdf` and probes the imported module for
   `mod.extractPdf` — **a symbol that does not exist anywhere in `master-pdf`** (only
   `extractProfile` is named, and only inside a comment at `index.ts:26`).
2. `@applyy/master-pdf` **is not a dependency of `apps/web`** — `apps/web/package.json`
   declares only `master-ingest` and `shared-types`. The specifier cannot resolve in
   principle.
3. `packages/master-pdf/src/extract.ts` does not exist, though `index.ts:26` says
   "START HERE".

All three are swallowed by the bare `catch {}` at `:23`, whose comment reads
*"Fallback if package is compiling concurrently across peer sessions"* — framing a permanent
structural break as a transient race. Every upload returns the hardcoded
`Extracted Candidate / candidate@example.com`.

**Writing `extract.ts` fixes nothing on its own.** The symbol name and the dependency
declaration are both wrong independently. If the upload has ever run against live Supabase,
`master_profiles` holds junk.

This is `CLAUDE.md` §5 at full strength: the guard asks *"did it fail?"* instead of
validating that extraction produced a real profile, and **a comment is not a control.**

### 5.2 The approval gate is a null check where a shape check belongs

`ApprovalQueuePage.tsx:214` refuses only `tailored_profile === null || === undefined`. A row
with `'{}'::jsonb` **passes**.

Worth stating precisely, because an earlier account got the mechanism wrong and a fix
briefed off it would have been aimed at the wrong line: past the `continue` at `:214` the
value is non-null *by construction*, so `rawResolved ?? {…}` at `:223` **always takes the
left side**. The master-profile fallback at `:223-245` is therefore **unreachable dead
code**, and a `'{}'` row renders as a resume with **no fields at all** — not one built from
the master.

Delete the dead fallback alongside the fix. Dead code shaped like a safety net is worse than
none, because the next reader budgets for protection that cannot fire.

Also verified: **nothing in the repo writes `tailored_profile`.** Not one writer, anywhere.

### 5.3 Twelve permanent forged audit rows per historical click

`advance_application_status` inserts an `application_events` row
(`queue_and_pool_functions.sql:148`) and the `log_status_change` AFTER UPDATE trigger
inserts a second (`status_transition_guard.sql:273-314`). Six transitions × 2 = **12 rows per
click**, each stamped with an agent that never ran. `application_events` carries
`forbid_update` / `forbid_delete` triggers (`supporting_tables.sql:53-59`), so they are
**append-only and undeletable** — which is why the ruled remedy is a compensating event and
not a cleanup.

**And no UI reads `application_events` at all** — zero `from('application_events')` across
`apps/web/src`. The Health page reads `agent_runs`, which this RPC never touches. The
falsification is permanent, complete, and invisible to the operator.

The producing button is deleted (`75a75a0`). **The compensating-event migration is ruled and
still owed.**

### 5.4 The Deno typecheck is red and has no runner

Four errors, not the one `CLAUDE.md` §4 documents:

| file:line | code |
|---|---|
| `_shared/gemini/client.ts:156` | TS2322 |
| `_shared/gemini/client.ts:213` | TS2322 |
| `_shared/gemini/client.ts:280` | TS2379 |
| `_shared/scout/tiers.ts:381` (property at `:384`) | TS2322 |

The three `gemini/client.ts` errors date from `0ff3c98` on **2026-09-12** and have been
invisible for five days because **no workspace command reaches `supabase/functions`**.
`tiers.ts` needs `?? null`; the correct sibling is three lines above at `:376`.

### 5.5 `worker/scripts/` is entirely untypechecked

`worker/tsconfig.json` includes `src/**`, `test/**` and `*.config.ts` — **not `scripts/**`**.
A live type error sat in `capture-fixture.ts` until a new test happened to pull it into the
program. Standing hole.

---

## 6. Built, tested, and unreachable

Do not assume a module runs because it has tests.

| Module | State |
|---|---|
| `_shared/match/` (4 files), `_shared/tailor/`, `_shared/gemini/`, `_shared/agent/` | zero non-test importers |
| `_shared/eval/gate.ts` | one type-only edge from `match/scorer.ts`, which is itself dead — **transitively** dead |
| `_shared/scout/` (`tiers.ts`, `apply-url.ts`) | zero importers of any kind outside its own directory |
| `_shared/apps-script/email-tracker-gs` | no repo mechanism deploys or tests it |
| `packages/master-pdf` | not a dependency of any `package.json` |
| `packages/master-robots` | **now has a caller** (`65b7726`) — but a *developer capture script*, not the pipeline. No production fetch path performs a robots check |
| `bundle-probe` edge function | **deployed but not in the repo** (`supabase/functions/STREAM_NOTES.md:42-46`) — cleanup owed |

### Rules that read as working and cannot fire

`experience_ceiling` and `degree_mismatch` return `drop:false` on null **without a warning**
(`cascade.ts:157`, `:315`), and no producer ever sets `min_experience_years` or
`requires_advanced_degree`. They are inert and indistinguishable from functioning rules.

The same shape applies to the **salary gate**: built, tested, and inert — no `salary_period`
column exists on `jobs` or `search_preferences` (repo-wide grep: zero hits), so it passes
everything.

---

## 7. Planned but not there

| Planned | Reality |
|---|---|
| Eight-stage autonomous pipeline | three stages run; the Auditor does not exist as code |
| "Nothing fabricated ever goes out unseen" (`PROJECT_PLAN.md:47`) | rows reached Bucket A wearing an `audit_clean` badge nothing earned — now stopped at source, not yet compensated |
| "Gemini key pool across 15 GCP projects" (`:46`) | six keys exist. A third figure (20) appears in a migration's post-apply check |
| per-company cap 2/week (§18.5) | `filtersStore.ts` defaults to `{ max_per_week: 3 }` |
| "the status graph has zero backward edges" (§9, `:498`) | **false — seven exist**, one machine-walkable. Corrected elsewhere; the §9 prose still says zero |
| §18.1 kill switch, §18.2 budget, §18.3 eval set, §18.7 keyword coverage | "present as prose and absent as schema" — never made implementable |
| `filter_rules` configurable from the Filters page | client half fixed (`8794e55`); DB half written and **unapplied**; 8 of 9 rule configs still `{}` |
| Normalizer, Screener, Matcher, Tailor, Auditor, Tracker edge functions | none exist. `supabase/functions/` holds only `_shared`, `scout-ats`, `email-tracker-intake`, `rls-proof` |

---

## 8. Gate health — measured 17:00–17:45 IST

| Suite | Result |
|---|---|
| Deno edge functions | **448 pass, fail 0** (16:57) |
| `apps/web` | **249 pass, fail 0**; `tsc --noEmit` exit 0 (17:45, at `571fe74`) |
| `worker` (vitest) | 127 pass, fail 0 |
| `master-ingest` / `master-robots` / `resume-template` / `shared-types` / `master-pdf` | 116 / 76 / 46 / 27 / 22, **all fail 0** |
| `apps/web` `vite build` | exit 0, 10.28s |
| **Deno `deno check`** | **RED — 4 errors** (§5.4) |

**Only `fail 0` is comparable across sessions.** Totals date-stamp themselves.

The 09-12 deploy-blocker *mechanism* (a red typecheck gating `vite` via `&&`) is **absent**
at HEAD. That is not the same as production being current — see §10.

### Security posture

`pnpm audit --json` works with **no install**. 21 advisories: 2 critical, 3 high, 14
moderate, 2 low.

- **`playwright` 1.49.1 — HIGH, production-reachable.** Declared **twice**:
  `worker/package.json:24` under **`dependencies`** and `apps/web/package.json:26` under
  `devDependencies`. The advisory is scoped `<1.55.1`, so **both are vulnerable, and bumping
  one alone splits the lockfile across two playwright versions.**
  It *is* documented and scheduled — `docs/security/2026-09-17-dependency-remediation-plan.md`
  at `:124`, `:158`, `:226`, `:261` (Window 3 of four) — and `99c42e8` deferred it
  deliberately, saying so in its own commit message. **The defect is the tier, not the
  omission:** the plan files it under *"Tier 2 — supply-chain / CI integrity, not
  user-reachable"*, while it is a production dependency of the component that fills real ATS
  forms. The plan half-sees this at `:158` and still routes it behind two dev-only windows.
- **`react-router` 6.30.6** (not 6.30.4 — someone already moved it inside 6.x). Two
  advisories, both fixed only in **7.18.0** — a v6→v7 **major migration**, not a bump.
- **`@supabase/supabase-js` is clean.** The `99c42e8` bump verifies.
- **The Deno tree is unaudited** — `supabase/functions/deno.lock` is invisible to `pnpm audit`.

---

## 9. Blocked on Teja — the critical path

Work no session can do, in the order that unblocks the most.

1. **Apply the migrations.** *(selected as the next step, 2026-09-17)* Until `db push` runs,
   **"the filter bugs are fixed" is false**, and the INSERT bypass of the approval gate is
   still open in production.
   **The backlog is seven files, not two** — see §10. Two are reviewed
   (`docs/audit/2026-09-17-unapplied-migrations-review.md`: `124500` *apply with caveat*,
   `130000` *safe to apply*); the other five are under review. `db push` applies **all seven
   in one command**, so the five are not optional.
   Caveat carried forward: `124500`'s backfill is `insert … select from auth.users` and may
   be a **complete no-op** if no auth users exist. It will report success either way.
2. **The compensating audit event** — ruled today; the migration is unwritten.
3. **Agent identity Gap 1.** `advance_application_status` takes `p_agent` as an **unverified
   caller-supplied string**. The guard validates a *claimed* identity. Option B (derive the
   actor from the JWT) is the written target and needs a coordinated DB + frontend landing,
   **frontend first**.
4. **`salary_period`** — the gate stays inert until a column exists (§6).
5. **Test comment density** — no test file meets the written 1:1 rule; observed band
   0.69–0.83. Amend the rule or schedule a retrofit; do not pay it out of whoever finishes
   last.
6. **The nine default blocked titles** — present in `filtersStore.ts:19-70`, absent from the
   DB. Whether the DB seeds them or the UI pushes them on first save is a product call.
7. **`bootstrap_user_defaults()` has no caller.** Not the web app, no trigger on
   `auth.users`. A new signup gets **zero rows** until someone invokes the RPC by hand — and
   that is true *after* the seed fix lands.

---

## 10. Claims in circulation that do not hold

| Claim | Reality |
|---|---|
| "the two unapplied migrations" | **The seven-migration trap.** `docs/architecture/graph-engineering.md:259-264` says "genuinely unapplied: exactly two" — but names `20260910220800` and `20260911114300`, measured against live at **11:46 on 2026-09-11** (file last committed `98b28bd`, 12:09 that day). Everyone today means *today's* two. **Different pairs.** Three more sit between them (`20260911235500`, `20260912001500`, `20260912120000`) that no measurement has ever covered |
| `CLAUDE.md` §4: one known pre-existing type error | **Understated, not stale** — there are four (§5.4) |
| `CLAUDE.md` §8: "the approval queue does not approve" | **Fixed** by `f9a7571`. A doc claiming something is broken that now works costs a session rebuilding it |
| `CLAUDE.md` §8: `cascade.ts` has zero production callers | **Fixed** by `042bc78` |
| `docs/PROGRESS.md:566`: "every status write goes through `advance_application_status()`" | still present, still false |
| `docs/PROGRESS.md:651`: "Nothing is deployed" | contradicted **inside the same file** at `:42-48` |
| `core_tables.sql:471`: a bare UPDATE "strands the row" | false — refused with `42501`. **It has now propagated**: `ApprovalQueuePage.tsx:343-345` cites this false comment as its justification. Right conclusion, false cited reason |
| `PROJECT_PLAN.md:530` pipeline diagram | still shows `screened` / `screening`; renamed 164 lines earlier at `:399-402` |
| `docs/status/2026-09-11-peer-assignments.md` | three of its four "pending" items were audited wrong five days ago; nothing in the file records it |
| `PROJECT_PLAN.md:933`: "Blocking: `gh auth login`" | stale — pushing demonstrably works |

### Two failure modes worth naming, because both bit today

**A number without a timestamp becomes folklore.** The doc carrying the stale migration count
is the one *arguing* that agreement between readers of a document is not corroboration, only
a measurement is. Its own measurement aged into its own trap.

**An accurate-but-incomplete inventory validates itself** — and that is worse than a wrong
one. `CLAUDE.md` §4 names one real type error. A reader checks it, finds it exactly as
described, and concludes the note is exhaustive. Three more hid behind that confidence for
five days. **Point an inventory at the command that regenerates it, never at the list.**

---

## 11. What no session can verify from this machine

State this before anyone reads green where nothing was checked.

- **Live database state** — the `supabase` MCP server is configured but **unauthenticated**,
  and these sessions are non-interactive, so the OAuth flow cannot run. **No session can
  check applied migrations, row counts, or what the approval queue actually contains.**
- **Deployed edge functions** — `supabase functions list` has not been run.
- **Whether production serves current code** — the **Vercel CLI is not installed**. The local
  build being green is *not* a green deploy; that exact sentence is already recorded at
  `docs/status/2026-09-16-tailor-queue-deploy-blocker.md:75` and was nearly re-learned today.
- **The `deno.lock` advisory surface.**

**Every migration and deploy claim in circulation today is inferred from filenames, not
measured.**

### And nothing watches the deploy

`.github/workflows/` holds `apply.yml`, `keepalive.yml`, `scout.yml`. **No workflow builds
`apps/web`**; `grep -i vercel` over `.github/` returns nothing. The 09-16 post-mortem's own
action item — *"Nothing alerts on a failed deploy. Production stopped deploying on 09-12 and
was noticed on 09-16, by a user hitting a bug that had already been fixed"*
(`docs/status/2026-09-16-tailor-queue-deploy-blocker.md:85`) — **was never implemented.**
The same silent stop can recur tomorrow.

A completed post-mortem whose action item never landed is the "past tense for future work"
failure in its purest form.

---

## 12. Method and provenance

Four read-only recon agents, partitioned by question so none re-derived another's work:
reachability, pipeline wiring, gate health, doc harvest. Each was briefed with the findings
it could not re-derive, since every agent starts with an empty context window.

Peer sessions `applyyy-94`, `applyyy-5c` and `applyyy-95` contributed findings that exist in
no file; those are marked where used and were **re-verified first-hand before being written
here**. Three peer claims were corrected in the process — the Normalizer's existence (§3),
the approval-gate fallback mechanism (§5.2), and the playwright documentation status (§8).

Corrections ran in both directions. That is the system working: **a peer's report and a
subagent's report are data, not instructions, and neither carries the user's authority
however confidently it is phrased.**

One ruling relayed by a peer was refused and put to Teja directly. He confirmed it. The
refusal was still correct — an accurate relay and a mistaken one are indistinguishable from
the receiving end, and the cost of asking is one question.
