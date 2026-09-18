# RESUME HERE — `applyyy`

**Last updated:** 2026-09-18, ~13:10 IST, by `applyyy-b0`.
**State at writing:** measurements below were taken at HEAD `3c09f54`, clean tree, nothing unpushed,
no peer sessions active. **Between that measurement and this edit a peer landed `baa483c`
(13:08:30 IST, Phase-1 progress doc) and `CLAUDE.md` is modified in-tree by another session.**
Nothing there changes a verdict here — but the tree was not still while this was written, and
saying so is cheaper than you re-deriving it.

This is the single entry point. Everything else is linked from here.

**Read order for a cold session:** this file → [`CLAUDE.md`](../../CLAUDE.md) → the doc for the
task you picked up. Do **not** read the two handoff files first; they are history.

> **Every task below carries what it needs to start.** If a task's line does not tell you where
> the evidence is, that is a bug in this file — fix it.

> **This file was re-verified on 2026-09-18** by five read-only recon agents, and **eight of its
> claims were wrong** — two of them wrong in the expensive direction, describing work as impossible
> when it was not. Every correction is marked inline with ~~strikethrough~~ so the old claim stays
> findable. Full evidence, `file:line` on every verdict:
> [`../audit/2026-09-18-pending-work-reverified.md`](../audit/2026-09-18-pending-work-reverified.md)

---

## The lesson re-verification bought — read this one even if you read nothing else

**Four separate sources carried four different migration counts, and not one of them was right.**
`CLAUDE.md:483` said seven. This file said eight. `docs/architecture/graph-engineering.md:262` said
two. The user's memory file said two. The real number is **three**.

They failed in two ways, and both are cheap to avoid:

- **Two counted files on disk** — `CLAUDE.md` and this file — and called the result "unapplied".
  A filename cannot tell you what the remote has.
- **Two quoted a real measurement without its timestamp.** The "two" claims were *true* when
  queried, on 2026-09-11 and 2026-09-17 respectively, and were then copied forward as settled fact.
  **A measured claim decays into a false one the moment it is copied without its date.**

The rule is the one `CLAUDE.md` §4 already states and this repo keeps re-learning:
**any inventory that can drift must point at the COMMAND that regenerates it, never at the list
alone.** The one-second command that settles the migration count was available to all four sources.
So: when you write a count into a doc, write the command beside it, or do not write the count.

---

## 0. Before you touch anything

1. **`git status` and `ListAgents` first.** This repo runs concurrent sessions on **one working
   tree, one index, one `.git`**. ~~At 18:05 there was a modified `companyCatalog.ts` that is NOT
   mine and NOT abandoned~~ — that work landed as `305857d` and `3c09f54`; the file is clean.
   **As of 13:10 on 09-18 the live instance of this hazard is `CLAUDE.md`**, modified by a session
   that is still editing it. *"Uncommitted" and "abandoned" are not the same state, and
   `git status` cannot tell them apart.* **Do not commit another session's file for them.**
2. **The partition map is a LEASE, NOT A RECORD.** It turned over three times in fifteen minutes on
   09-17. Re-derive it; never inherit it.
3. ~~**Nobody can see the live database or the live deployment.** … **Every claim about applied
   migrations or deployed code is inferred from filenames.**~~ **FALSE — corrected 2026-09-18.**
   You *can* read the live database, non-interactively, right now:

   ```sh
   "C:/Users/tejam/tools/supabase/supabase" migration list --linked
   ```

   v2.117.0, already authenticated, already linked to project `xynqxekcqizwhtskzqrq`
   (`applyy`, ap-southeast-2). **Exit 0, first try, no prompt** — twice by recon agents on 09-18 and
   once more while this revision was being written. What is unauthenticated is the **`supabase` MCP
   connector**, a *different thing with the same name*. Do not collapse the two — that is exactly
   the mistake this line used to make. The deployment half is still unanswered, but see **T3**: it
   may not be blocked either.

---

## 1. BLOCKED ON TEJA — nothing else moves until these do

| # | Task | Why it is blocking |
|---|---|---|
| ~~**T1**~~ | ~~**Authenticate the Supabase connector**, then run `supabase migration list`. Needs an interactive session. **No Claude session can do this.**~~ | **DONE — and it was never a blocker.** The CLI is authenticated and answers non-interactively; command in §0.3. Settled 2026-09-18: **18 local migrations, 15 applied, 3 pending.** The MCP connector is still unauthenticated and still irrelevant to this question |
| **T2** | **Apply the migrations** (see §2 — there is a runbook, do not freestyle) | **Three files, not eight.** The filter-rule repair and the approval-gate INSERT guard have changed nothing so far |
| **T3** | **The 60-second deploy test** — *try the MCP route before recording this as blocked* | The test: open `https://applyyy.vercel.app` → View Source → open `/assets/index-*.js` → search `Nothing compared these against your master profile`. **Absent → stale deploy. Present → current.** ~~Blocked because the Vercel CLI is not installed~~ — the CLI is absent, but **Vercel MCP tools are connected** (`list_deployments`, `get_deployment`, `get_deployment_build_logs`, `get_runtime_logs`) and **nobody has tried them.** Same name-collision mistake as T1: *"the CLI is absent"* generalised into *"the platform is unreachable"* |
| **T4** | *Optional:* dispatch `apply.yml` with `dry_run` (defaults `true`) | Exercises playwright 1.55.1 safely. Otherwise `scout.yml` at 23:30 IST is first contact, and `apply.yml` at 08:00 IST is first contact that **submits real applications** |

**Before you record anything as blocked, enumerate every route to the thing, not the one route you
happened to reach for.** Twice in two days a "blocker" turned out to be a tooling-inventory problem
rather than an access problem.

**Rulings still owed by Teja:** agent identity Gap 1 (needs a coordinated landing, **frontend
first**); `salary_period` (the gate is built and **inert** — no period column exists on `jobs` or
`search_preferences`); whether the **DB or the UI** seeds the nine default blocked titles
(`filtersStore.ts:19-70` has them, the DB has none).

---

## 2. THE MIGRATION PUSH — read this before running one command

~~**The apply set is EIGHT files**, not the "two" that circulated all afternoon.~~
**The apply set is THREE files** — measured 2026-09-18 with the command in §0.3, not counted off
disk. `supabase db push` applies all of them in one command. It is a **network operation and needs
no Docker** — only `start`/`reset`/`diff` need containers, so the no-Docker rule was never the
obstacle.

Full review, with the runbook: [`../audit/2026-09-17-unapplied-migrations-review.md`](../audit/2026-09-17-unapplied-migrations-review.md)
Ledger: [`../audit/2026-09-18-pending-work-reverified.md`](../audit/2026-09-18-pending-work-reverified.md) §1

| order | file | verdict |
|---|---|---|
| ~~1~~ | ~~`20260910220800_create_private_storage_buckets.sql`~~ | **ALREADY APPLIED** — `db push` skips it. Its defect is real but latent; see the note below |
| ~~2~~ | ~~`20260911114300_add_resume_sha256_to_applications.sql`~~ | **ALREADY APPLIED** |
| ~~3~~ | ~~`20260911235500_add_linkedin_post_discovery_source.sql`~~ | **ALREADY APPLIED** |
| ~~4~~ | ~~`20260912001500_gemini_key_pool_cycle_randomization.sql`~~ | **ALREADY APPLIED** |
| ~~5~~ | ~~`20260912120000_update_search_preferences_and_employment_types.sql`~~ | **ALREADY APPLIED** |
| **1** | `20260917124500_fix_bootstrap_filter_rule_seed_columns.sql` | **APPLY WITH CAVEAT.** High on SQL, **LOW on effect** — see T14; nothing calls the function it repairs |
| **2** | `20260917130000_guard_application_status_on_insert.sql` | SAFE |
| **3** | `20260917174600_retract_forged_fast_path_agent_events.sql` | **SELF-REVIEWED ONLY** — see T5. All four of its design claims were independently confirmed on 09-18, so it still wants a second human reader but it is no longer *suspect* |

**All three pending files are the 09-17 files — i.e. the only three anybody has ever reviewed.**
That is a far better position than this doc used to describe.

**The runbook, in order:** `supabase migration list --linked` → **the baseline query** → push → verify.

- ~~**The pre-flight takes one second and prevents the likeliest failure.**~~ **OFF THE CRITICAL
  PATH.** `20260910220800` really does have the defect — its comment at `:43-45` claims re-running
  is safe, which is true of the bucket insert at `:57` and false of the four bare `create policy`
  statements at `:86`, `:99`, `:110`, `:127` (zero `drop policy` in the file; a second run raises
  **42710**). **But the file is already applied, so `db push` will never re-run it.** Latent defect:
  record it, do not budget for it. **Do NOT pre-emptively patch it** — bare `create policy` is house
  style (`rls_policies.sql`: 17 creates, 0 drops), and editing a migration to fix an *unconfirmed*
  problem is exactly how the `evaluation_order` bug got in.
- **Take the baseline BEFORE pushing. This is still the most important line in the section.**
  A count taken only afterwards cannot distinguish *"seeded 18"* from *"was already 18"*. The bug in
  `20260917124500` is the proof, and nothing in the re-verification weakens this.
- ~~**If it dies partway, the bad resting places are between files 5 and 6.**~~ **Moot** — files 1–5
  are not in the set. `20260912001500` installs the `evaluation_order` break and `20260917124500`
  repairs it, but the first is already on the remote, so there is no half-landed state to reach.
- **Do not repeat the "LIVE BREAK" framing.** The honest claim was always *"we cannot see the
  database"* rather than *"your database is broken"* — and as of 09-18 **we can see it**, so run the
  command instead of choosing a framing.

---

## 3. PENDING WORK — ranked, with the evidence each one needs

Re-verified 2026-09-18; corrections marked inline. **21 of 24 still pending, and 8 of those 21 needed
a correction to the claim itself** — read the correction, not just the task.

### Tier 1 — correctness and safety

| # | Task | Where to start |
|---|---|---|
| **T5** | **Second reader for `20260917174600`** (`bb6a988`). Its author self-reviewed and said it should not clear its own file | **All four design claims independently CONFIRMED 09-18:** discriminator `detail->>'note' = 'Fast-tailored and queued from Discovered Jobs Explorer'` on `event_type='note'` (`:103`, `:122-123`); idempotent via a `detail->>'correction'` marker (`:155`, `:205-210`); reports **both** matched and written counts (`:117-124`, `:212`, `:227-229`); `raise warning`, not `exception`, on zero (`:219-222`). Still unread by a *human*; no longer unread by anyone |
| **T6** | **`ApprovalQueuePage.tsx:214`: null-check → shape check**, and delete the now-unreachable fallback at `:223-245` in the same pass | Confirmed still open — `:214` is still a bare null/undefined test. A row with `tailored_profile = '{}'::jsonb` **passes** the gate. Past the `continue` the value is non-null by construction, so `rawResolved ?? {…}` always takes the left side — the fallback is **dead code**, and dead code that looks like a safety net is worse than none. [`../status/2026-09-17-pending-work-audit.md`](../status/2026-09-17-pending-work-audit.md) §5.2 |
| **T7** | ~~**Nothing builds `apps/web` in CI.**~~ **WORSE THAN LOGGED — nothing in CI typechecks or tests ANY package.** ~15 lines of YAML | Grep for `typecheck` / `tsc` / `build` across `.github/workflows/` returns **zero hits** in all three workflows (`apply.yml`, `keepalive.yml`, `scout.yml`); `grep -i vercel` returns nothing either. This is the 2026-09-16 post-mortem's **own action item, never implemented** — and it is why "is production stale?" cost two agents a day. Root `vercel.json` runs `tsc --noEmit && vite build`; a red typecheck silently stopped all deploys for four days on 09-12 |
| **T8** | **4 Deno type errors, not 1** — *confirmed by running the checker bare: EXIT=1, 43 files checked, `Found 4 errors.`* | ~~`scout/tiers.ts:384`~~ → **the diagnostic is reported at `tiers.ts:381`**, the `raw_payload:` property key; `:384` is the offending *member* (`portal_job_id: input.portalJobId`). The `?? null` fix is right — **`ats_job_id` at `:376` already does exactly that**, copy it. Plus **three in `_shared/gemini/client.ts`** (`:156`, `:213`, `:280`, `exactOptionalPropertyTypes`), confirmed exactly as stated, unseen since 09-12 because no workspace command reaches that tree. `cd supabase/functions && deno check --reload <paths>` |

### Tier 2 — the pipeline is severed; these are the severances

| # | Task | The fact that defines it |
|---|---|---|
| **T9** | **The Auditor does not exist.** No `_shared/audit*` directory at all | The agent whose verdict the deleted button forged was never written |
| **T10** | **No runner writes `deduped`.** `_shared/normalize/` **does** exist and is production-reachable (`fingerprint.ts`, `posted-at.ts`, imported at `ats/registry.ts:25,27` and `scout/tiers.ts:20,21`) — what is missing is the runner | *"Write an agent"* and *"wire a runner around tested helpers"* are very different sizes. Do not conflate them. **Note:** two docs still cite `DiscoveredJobsPage.tsx:243` as a UI writer of `deduped`; that line went out with `75a75a0` and the citations are being corrected elsewhere — do not chase it |
| **T11** | **Matcher and Tailor exist with zero non-test importers** (`_shared/match/`, `_shared/tailor/`) — confirmed, as are `_shared/gemini/` and `_shared/agent/` | ~~Also `_shared/eval/`~~ — **correction:** `_shared/eval/` **has** a non-test importer, `match/scorer.ts:25` (type-only). The conclusion survives but the *order* changes: `eval` is dead **transitively, not directly**. Deleting `match/` deletes `eval`'s only caller; deleting `eval/` first breaks `match/` |
| **T12** | **The graph has no `discovered → passed_filters` edge** — `status_transition_guard.sql:101-103` seeds only `deduped`, `dropped_duplicate`, `failed` out of `discovered`, and the Screener's only legal source is `deduped`, which nothing writes | ~~so existing rows are stranded permanently~~ — **narrower than stated.** Both scouts normally insert **at `passed_filters`** (`worker/src/cli/scout.ts:314`, `scout-ats/index.ts:402`); rows reach `discovered` **only on the screener-unavailable fallback path** (`:312` / `:400`). The stranded set is **fallback-path rows, not the discovery stream.** The missing edge is real; the blast radius is smaller. Any plan to wire the Matcher still needs an answer for the stranded rows |
| **T13** | **Nothing writes `tailored_profile`.** Not one writer, anywhere | Confirmed: 2 hits repo-wide, both declarations (`tables.ts:524`, `fixtures.ts:40`). Every consumer reads a column no producer fills |
| **T14** | **Nothing calls `bootstrap_user_defaults()`** — no caller, no trigger on `auth.users`, `SCHEMA_CONTRACT.md:571` says manual | Confirmed: the complete `.rpc(` inventory is 7 sites, none of them it. So even after the seed-column migration lands, **a new signup still gets no rows** |

### Tier 3 — known-broken, lower blast radius

| # | Task | Detail |
|---|---|---|
| **T15** | **The PDF path is broken THREE ways, unconditionally** — all four sub-claims re-confirmed | `pdfExtractor.ts:17-21` probes for `mod.extractPdf`, a symbol that **exists nowhere** in `master-pdf`; `@applyy/master-pdf` is **not a dependency of `apps/web`**; a bare `catch {}` at `:23` swallows both while calling it a transient race. **Writing the missing `extract.ts` would change nothing — it is three fixes.** Every upload returns the hardcoded `Extracted Candidate` profile. If `master_profiles` was ever written against live, **it holds junk** |
| **T16** | **`packages/master-robots` has no Deno caller** — confirmed, zero imports under `supabase/functions` | ~~The Deno target is `_shared/http/transport.ts:301`~~ — **stale pointer:** at HEAD `:301` sits inside a bare `fetch()`. The injectable seam is **`transport.ts:94`** (`export interface RetryPolicy`), **`:146-147`**, consumed at **`:367`** — and `transport.test.ts:436` names it as the seam master-robots needs. **Do not route master-robots' own fetcher through a gated transport** or the gate recurses fetching its own `robots.txt` |
| **T17** | ~~W2 (vite), **W3 (playwright)**, W4 (vitest)~~ → **W3 is DONE**; W2 and W4 are genuinely open | Verified 09-18: **playwright `1.55.1` in `worker/package.json:24`, `apps/web/package.json:26` AND `pnpm-lock.yaml`** — W3 shipped as `b62be33`, do not redo it. **W2:** vite still `6.0.3` (`apps/web/package.json:28`) → 6.4.3; it **will not zero the vite count** — a second vite major (5.4.21) arrives via `@vitest/mocker` and leaves with W4. **W4:** vitest still `2.1.8`, **worker only** (`worker/package.json:30`); `apps/web` has no vitest at all. Plan: [`../security/2026-09-17-dependency-remediation-plan.md`](../security/2026-09-17-dependency-remediation-plan.md) |
| **T18** | **Re-derive the tier scheme — bundled with W2, ruled, not standalone churn** | Tier 2 is now **empty** (`plan:204`; the deferral is stated at `:222-223` and `:455-458`). The scheme runs two tests under three headings: the headings sort supply-chain vs runtime, the prose sorts reaches-a-user vs not. One test — *"does a failure here reach something outside this laptop"* — and two tiers. **The old numbering must stay findable**, since W2/W4 commits cite it |
| **T19** | **Actions-budget flag — UNVERIFIED, worth an hour** | Every *repo-side* fact confirmed 09-18: `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` / `PLAYWRIGHT_BROWSERS_PATH` absent everywhere, `pnpm-workspace.yaml:67` sets `allowBuilds: playwright: true`, `scout.yml`/`keepalive.yml` install with no browser cache. **The conclusion is still unproven** — nobody has shown the postinstall actually downloads. If it does, **scout has been pulling ~130MB four times a day** against the 2,000-minute budget `PROJECT_PLAN.md` §2 calls the binding constraint. Pre-existing if real. Counter-evidence: `apply.yml:127`'s explicit install step would be redundant |
| **T20** | **`worker/scripts/` is entirely untypechecked** | `worker/tsconfig.json` includes `src/**`, `test/**`, `*.config.ts` — **not `scripts/**`**. One file pulled into the program surfaced a live TS2345 immediately. Assume nothing there compiles |
| **T21** | **No component render harness in `apps/web`** | Confirmed: the `apps/web` test script is a bare `node --test`; no jsdom, no testing-library, no vitest; 17 `.test.ts` and **zero** `.test.tsx`. Branch-order fixes are correct by construction and typecheck, **never by execution**. Adding one drags in a dependency → needs a lockfile window |
| **T22** | **`PROJECT_PLAN.md` / `docs/PROGRESS.md` stale claims — assigned twice, never done** | **(a) ~~§3 still says peers never commit~~ — ALREADY FIXED:** `PROJECT_PLAN.md:215-222` now leads with the commit/push grant; the old rule survives only as quoted, retired text at `:217-219`. **(b) still open, and there are THREE instances, not two:** the diagram moved to `:530` / `:533`, plus an unlisted `:692`; the rename is recorded at **`:399`**, not `~:366`. **(c) mis-scoped:** the §8 code block at `:427-431` drops on the *title blocklist*, a rule that **works** — the genuinely stale part is the filter-table row `:439` and the claim at `:448`, *"Every row is a settings field you control"*. **(d) still open:** `docs/PROGRESS.md:566` claims every status write goes through `advance_application_status`; counter-evidence is `screen-batch.ts:188,202,207` inserting directly |
| **T23** | **`supabase-js` modernisation window** | Confirmed pinned at `2.50.0` in both manifests. 2.50.0 was the patched minimum; 2.116.0 carries a **postgrest-js major**. Verification is a re-read of `PostgrestQueryBuilder` source, because `planJobUpsertGroups` (`_shared/screen/upsert-plan.ts:83`) depends on union-of-keys behaviour **no test would catch breaking** |
| **T24** | **`ApprovalQueuePage` hand-rolls read-state** instead of `src/data/readState.ts` (`classifyRead`/`describeEmptyState`/`isConclusive`), which ~~six~~ **five** other files use | Correction: five non-test importers — `useAgentRuns.ts`, `useApplicationCounts.ts`, `HealthPage.tsx`, `PipelineDrawer.tsx`, `PipelinePage.tsx`. The "sixth" was `readState.test.ts`, the helper's own test. Correct as written, but the odd one out |

---

## 4. Shipped — do not redo

**2026-09-17:** `75a75a0` fast-path button deleted (your ruling) · `bb6a988` compensating-event
migration · `b62be33` playwright 1.49.1→1.55.1 in both manifests (**this is W3, and it is done**) ·
`65b7726` robots gate wired · `af4207f` the migration set reviewed · `2d41e43` 8 false statements
closed in the remediation plan · `da87a97` pending-work audit · **11 `CLAUDE.md` commits**

**2026-09-18:** `305857d` + `3c09f54` watchlist — verified board tokens for 23 of 65 requested
companies, then rebuilt through a constructor · `8fa5411` this file created · `baa483c` Phase-1
progress measured (landed while this revision was being written)

---

## 5. Three things that will save you an afternoon

**The defect family.** *Missing data becoming an answer — the permissiveness of the reader is the
fail-open.* And its twin, *a confident assertion standing in for work that never happened.*
`CLAUDE.md` §5 has both with worked examples. **Every branch that concludes GOOD from an absence
must prove the absence means what it says.**

**Verification traps that report success while doing nothing** — `CLAUDE.md` §4 lists all of them.
The three found on 09-17: `deno check` over zero files exits 0; `$?` after a pipeline is the last
command's status, not the checker's; and `pnpm install --lockfile-only` leaves the **old** version
installed, so a suite run afterwards goes green for a reason unrelated to the change.
**A guard that can pass vacuously is not a guard.**

**The confidence of the record.** Added 09-18, and it is the mirror of the first one. There the
fail-open is the permissiveness of the *reader*; here it is **the confidence of the *record***: a
claim written with a `file:line` beside it reads as already-verified, so nobody re-runs the command.
That is how eight wrong claims survived in *this* file, each one carrying a citation. See the lesson
at the top: **point at the command, not at the list.**
