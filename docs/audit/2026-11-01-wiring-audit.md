# Wiring audit — agents, modules, tiers (2026-11-01)

**Scope:** whole repo at origin/main `8f9a2e7` (12:50 IST), plus the live Supabase project
`xynqxekcqizwhtskzqrq` (read-only SELECTs). Seven read-only recon agents, one per seam:
pipeline agent chain · web↔backend contract · worker + workflows · types/schema drift ·
security/auth · satellite agents + integrations · CI gates + deploy drift.

**Method:** every finding cites `path:line` and answers "is this path reached in prod?".
Rows marked **✔ orch** were re-measured by the orchestrator after the agent reported
(code re-read or live query re-run). The rest were not re-checked; they carry the agent's
own CONFIRMED / PLAUSIBLE label.

**Severity:** P0 = broken in prod now / unintended submit / exploitable with impact.
P1 = wrong behaviour on a reached path. P2 = latent, drift, or hardening.
**No P0 was found.** Nothing submits unintentionally today (`APPLYY_CRON_LIVE` unset; the last applier run was DRY).

---

## Fix status (updated 2026-11-01 16:45 IST)

Every fix below has a red-on-revert test and was gated in a clean worktree pinned to the
commit. Deploys ran from a worktree pinned to the commit SHA.

| Finding | Status | Commit | Deployed |
|---|---|---|---|
| W5 zero form fields block submit | **fixed** | `50ac7e3` | worker (runs from main) |
| W4 unusable approved rows | **fixed** | `50ac7e3` | worker |
| W10 daily cap | **fixed** (daily cap only). The other two columns are measured, not wired: `freshness_window_days=3` would drop 440/615 `passed_filters` rows; `max_applications_per_company_per_week=2` would drop 0 today. Ruling still open. | `50ac7e3` | worker |
| W14 skill-gap caller check | **fixed** | `2aac3c0` | skill-gap v16 (`72be0e3`) |
| W22 orphaned satellites | **wired**: `satellites.yml` runs daily at 18:53 IST. `APPLYY_SATELLITES_LIVE=true` was set after two manual runs; the second was all green. | `2aac3c0`, `72be0e3` | all five redeployed |
| (new) skill-gap crashed on its first live run (`s.toLowerCase is not a function`: skills are `{id,name,category}` nodes) | **fixed** | `72be0e3` | skill-gap |
| W8 browser scout fallback | **deleted** | `af3c7f0` | Vercel |
| W9 Health "has never run" | **fixed** | `af3c7f0` | Vercel |
| W11 Vercel ignore step | **fixed** | `af3c7f0` | Vercel |
| W6 tracker replay sweep | **fixed** | `2dbe677` | email-tracker-intake v25 |
| W7 same-company tie | **fixed** | `2dbe677` | email-tracker-intake v25 |
| W2 matcher usable-job gate | **fixed** | `4d57ce0` | matcher v31 |
| W3 paste fills description | **fixed** | `4d57ce0` | job-link-intake v3 |
| W1 SmartRecruiters descriptions | **dropped by ruling.** SR `robots.txt` is `Disallow: /` for all but LinkedInBot; Teja ruled "honor robots". All 12 SR boards were disabled (live write, 2026-11-01). The detail-fetch patch is kept out of the repo. SR job pages (`jobs.smartrecruiters.com`) answer robots.txt with an HTML soft-200, so paste and the applier refuse them too: SR jobs can only be applied to by hand. | none | n/a |
| **W39 (new)** the two scouts disagreed on robots | **fixed.** The worker scout had no robots gate (it was the only path scouting SR and Ashby). Both scouts now gate. Ruling: a 401 robots.txt is "no rules" for board reads only (api.ashbyhq.com answers 401); the applier stays strict. | `ad19be5` | scout-ats v29, scout-web v20 |

Open decisions from the fixes: whether a human paste may revive a `failed` row (needs a
`failed → passed_filters` edge); whether to add a short-description threshold (tailor and
matcher together); whether to wire or delete `matcher/freshness-queue.ts`; whether referral
should draft only for `scored`-or-later rows (it currently drafts 5/day from 615
`passed_filters`); interview-prep reads its batch before skipping packed rows.

---

## Root causes (read this first)

Most P1s trace back to **three missing shared rules**. Fixing each rule once, at the stage
every caller goes through, closes several findings at a time.

1. **"Is this job row usable?" is checked by the tailor only.** The tailor refuses rows with
   no description or `disappeared_at` set. The matcher (upstream) and the applier (downstream)
   lack the same predicate. → W1, W2, W3, W4.
   *Pattern:* validate at the first stage that can know (fail fast), with one predicate shared by all stages.
2. **One-shot side effects with no reconciliation loop.** The tracker tries a status move
   once and then forgets it. The scout falls back silently and still marks the run green.
   → W6, W12.
   *Pattern:* derive pending work from data (an outbox / reconcile sweep), so a missed attempt is retried.
3. **Hand-copied contracts with no compile-time check.** Row types are hand-written,
   `createClient` is untyped, and settings columns exist that no code reads. → W10, W20, W21.
   *Pattern:* generated types (`supabase gen types typescript`), which turn a missing column into a compile error.

---

## P1 — wrong behaviour on a reached path

| ID | Finding | Evidence | Reached / scenario | Fix |
|---|---|---|---|---|
| **W1** ✔ orch | **SmartRecruiters adapter never stores a description.** 124/124 live SR jobs have a null or <200-char `description_raw` (Greenhouse: 12/15,561). | `_shared/scout/adapters/smartrecruiters.ts:326` reads `jobAdDescription/description/content/jobAd` from the **list** entry. The list endpoint has no description, and `jobAd` is an object. | Scout runs twice a day. Every SR posting reaches the matcher with no description. The tailor then fails it, so **no SR job can ever reach `awaiting_approval`**. | Fetch the SR posting-detail endpoint (`jobAd.sections`) for each new posting. |
| **W2** | **The matcher scores rows the tailor is guaranteed to refuse.** It spends Gemini calls, then the row ends `failed` (terminal) or stays at `scored` forever. The matcher also has no permanent-failure exit, so rows that always fail sit at the head of the oldest-first queue. | `matcher/index.ts:343-345` (no `disappeared_at` or description filter), `:354` (`created_at` asc), `matcher/write-score.ts:90` (`MatcherTargetStatus = "scored" \| "dropped_filter"`, never `failed`). The tailor refuses at `tailor/index.ts:210-213`, `:294-299`. Live: the Symphony SR row scored 49, then failed `missing_description` 5 s later. | Queue today: 16/615 `passed_filters` rows are thin and 21/615 are disappeared. With `BATCH_LIMIT = 10` (`pipelineRunner.ts:57`), 10 rows that always fail would starve every browser batch. `matcher/freshness-queue.ts` (fresh-first ordering) is imported by nothing. | Before any Gemini call, move a no-description row `passed_filters → failed` (the matcher already has that edge) and skip disappeared rows. Either wire in `freshness-queue.ts` or delete it. |
| **W3** | **Pasting a link cannot rescue a scouted job with no description.** The pasted page text is discarded and the row still goes to the tailor. | `job-link-intake/index.ts:119` upserts with `ignoreDuplicates: true`. `:136` `tagManual` writes only `discovered_via` and `disappeared_at`. `handler.ts:48` `REVIVE_FROM` excludes `failed`. | Paste one of the 13 thin SR links: matcher → tailor → `failed missing_description`. Paste the already-failed Symphony link: 200 with `pipeline_started:false`, and nothing happens. | In `tagManual`, fill `description_raw` when the stored value is null or shorter. Decide whether a human paste may revive a `failed` row (that needs a new edge). |
| **W4** | **Five unusable approved rows at the head of the queue stop the applier silently.** | `worker/src/supabase-gateway.ts:248` (`!url`) and `:270` (`disappeared_at`) release the row and drop it from the result. `claim-loop.ts:353` `if (rows.length === 0) break;` runs with batch size 5 (`:211`). | 5 oldest approved rows that are unusable → each claim returns `[]` → "queue drained" → `agent_runs` shows succeeded. Newer approved rows are never tried. Not triggered yet (1 approved row live). | Hold unusable ids for the rest of the run (as `held` already does), and in live mode park them `approved → blocked_needs_human`. |
| **W5** ✔ orch (PLAUSIBLE trigger) | **A page with zero extracted form fields counts as "ready to submit".** | `apply-one.ts:514` `wouldSubmit = detected === null && plan.canProceed && attachment.canProceed`. `plan-resume-attachment.ts:120-121` returns `canProceed: true` when there are no file fields. Nothing checks `fields.length`. | The `apply_url` lands on a JD page, an iframe form or an unrendered JS form → `fields = []` → dry run logs `wouldSubmit=true`. A live run moves the row to `applying` and clicks the only visible `form button[type="submit"]` (`playwright-page.ts:765`), which may be a search or newsletter form. That is an unintended POST to an employer. | Treat `fields.length === 0` (or no name/email field) as an `unsupported_form` blocker. **Small change, large blast radius: do this before the next live submit.** |
| **W6** | **The email tracker loses status moves for good.** A move that fails, or is skipped while the kill switch is off, is never retried. | `email-tracker-intake/index.ts:392-393` attempts moves only for rows newly inserted in this call. `:426` skips every move when the kill switch is off but still returns 202. `:505-507` only logs the error. `:522` closes the run `succeeded`. No sweep re-drives the moves. | 0 rows are post-submit today. After the first real application, a rejection that arrives while paused, or a 409/42501, is lost, and the row stays `applied` forever. The same happens to emails that arrive while a row sits in `needs_verification` (`decide.ts:417`). | Each run, re-drive matched `email_events` that have no `status_change` event carrying their `provider_message_id`. |
| **W7** | **Two applications at the same company means none of its emails match.** | `email-tracker-intake/decide.ts:317-321` `return pool.length === 1 ? pool[0]!.id : null`. The title tiebreak (`titleNamedIn`) is used only for receipts (`index.ts:452`). | 1 of 8 in-flight companies already has 2 applications. Every rejection, OA or interview email from such a company is stored unmatched. | When the pool has more than one row, use `titleNamedIn` as the tiebreak for outcome emails too. |
| **W8** ✔ orch | **The browser "Scout Watchlist" fallback overwrites real job data and bypasses the kill switch.** | `apps/web/src/data/discoveryService.ts:223` falls back on any status except 401/403. `:322-323` sets `posted_at: now`, `posted_at_source: 'unknown'`. `:330` upserts on `user_id,fingerprint` **without** `ignoreDuplicates`, i.e. ON CONFLICT DO UPDATE. `:277-281` has no `enabled` filter. `:277` drops the error and reports "add companies first". | The browser invoke sends no `limit`; scout-ats runs take 523–866 s, so a gateway timeout is likely. The fallback then rewrites `posted_at` on real Ashby rows (all 6,982 are `exact` today), so stale jobs look fresh, and it polls the 25 disabled boards. A `kill_switch_read_failed` 500 also triggers it. | Delete the browser fallback. Show the scout-ats error, or "still running on the server" for a timeout. |
| **W9** ✔ orch | **The Health page says screener and normalizer "have never run".** They last ran 2026-10-24: stale for 8 days, not never run. | `apps/web/src/data/useAgentRuns.ts:65` `RUN_WINDOW = 200`, `:184` global `.limit`. `agentFreshness.ts:299-300` returns `never_run` when no row is in the window. Live: the newest screener run is at rank 253. `HealthPage.tsx:75` mentions a RUN_WINDOW note that is never rendered. | Tracker (170 rows) and scout_ats (177 rows) fill the window, so the operator sees the wrong alarm. | Read the latest run per agent (`distinct on (agent)` or an RPC), not a global top-200. |
| **W10** ✔ orch | **Three `system_settings` caps are shown or seeded but read by no code.** | `max_applications_per_day` is read and written only by `SearchPreferencesPage.tsx:142,392,818`. `max_applications_per_company_per_week` (live value 2) and `freshness_window_days` (live value 3) have zero readers. The real caps are `claim-loop.ts:153` `DEFAULT_MAX_SUBMITS = 3` per run and `filter_rules.per_company_weekly_cap`, whose live config is `{}` (`cascade.ts:330` warns "no max_per_week configured" in today's scout runs). | Teja sets "Daily Application Cap = 1" and the worker still submits up to 3 per run. Settings shows "2 per company per week" and no per-company cap is applied. | Make the claim path read `max_applications_per_day`. Seed `per_company_weekly_cap.max_per_week` from settings. Or remove the dead columns and their UI. |
| **W11** ✔ orch | **Vercel skips the web deploy when the *last* commit of a multi-commit push doesn't touch web paths.** | `vercel.json:4` `"ignoreCommand": "git diff --quiet HEAD^ HEAD -- apps/web packages …"`. Push head `78e5126` shows "Canceled by Ignored Build Step" while carrying `681b78e` (Manual apply page). Push head `90e005f` skipped `35c40b7` (vite security bump, Dependabot 48-59). | Web changes, including security dependency bumps, stay off prod until a later push touches a web path, and the skip shows green. | `git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- …`, and build whenever that variable is unset. |
| **W12** | **When screening can't load, the scheduled scout files postings at `discovered`, marks the run `succeeded`, and nothing consumes `discovered` on a schedule.** | `worker/src/cli/scout.ts:232-233` only warns. `:467` closes `succeeded`, exit 0. The edge copy does the same (`scout-ats/index.ts:293-295`, `:730`). `screening_applied` (`:766`) has no reader. The normalizer runs only from the manual `prescreen-drain.yml` (`:12-13`) or the browser. | One bad read of filter_rules or preferences during the cron → every new posting sits unscreened, the Health page shows green, and "Ready to tailor" goes quiet. | Record `screener_not_run` on the run (non-zero `error_count` or `failed`) and fail the workflow step. |
| **W13** | **Four package test suites (266 tests) never run in CI, including the robots.txt gate.** | `ci.yml` jobs: deno-check, edge-tests, web, worker, shared-types-tests. Nothing runs `packages/{master-ingest,master-pdf,master-robots,resume-template}`. All pass locally (117/24/76/49). `master-robots` is imported by scout-ats, scout-web, job-link-intake, `_shared/http/transport.ts` and `worker/src/apply-one.ts`. | A robots-gate regression lands on a green main. | Add a CI job: `node --test "packages/*/test/**/*.test.ts"` with the same count assertion. |
| **W14** ✔ orch | **`skill-gap` has no caller check, so anyone holding the public anon key can run it.** | `skill-gap/index.ts` imports only `readKillSwitch`, with no `authorizeCaller`. It goes from `:64` `createAppUserClient()` to writes. `verify_jwt=true` accepts the anon JWT that ships in the web bundle. The other 14 JWT functions call `authorizeCaller`. | `POST /functions/v1/skill-gap` with the anon key → signs in as Teja and upserts `skill_gap_reports` and `agent_runs`. No data leaks and no Gemini spend; the cost is anonymous writes plus a password grant on every call (see W15). The config.toml comments at :197/:235/:242 ("gateway rejects anonymous calls") are wrong for the same reason. | Add `authorizeCaller` after `:68`, as `follow-up/index.ts` does. Add a red-on-revert test: an anon bearer gets 401. |

## P2 — latent, drift, hardening

### Security / auth
- **W15 (PLAUSIBLE)** Every function signs in with Teja's password *before* checking the caller (`normalizer:80→93`, `scout-ats:137→149`, `screener:62→71`, `auditor:108→124`, `gmail-sync:40→50`; `_shared/db/client.ts:132`). Four of them are `verify_jwt=false`. A tokenless loop runs one password grant per request. If GoTrue rate-limits by the edge egress IP, the pipeline's own sign-ins fail (503). Fix: verify the bearer first (`getUser(token)` / `getClaims`), then sign in.
- **W16** One `EMAIL_INTAKE_SHARED_SECRET` guards three entry points (email-tracker-intake, rls-proof, the Apps Script `doGet`), and it travels in a URL query (`gmail-sync/index.ts:69`), so it lands in Google-side logs. Fix: one secret per entry point; send it in a POST body.
- **W17** job-link-intake is open to DNS rebinding: the host is resolved and checked (`fetch-page.ts:144`), then `fetch` resolves it again (`index.ts:189`). Blind SSRF, and Teja has to paste the link. Fix: pin the IP that was checked.
- **W18** The agent-key gate fails open when the key table is empty (`agent_key_state()` returns `'unconfigured'`, which is only a WARNING). Closed today (1 row). Now that the key is seeded, treat `unconfigured` as refuse and add an explicit emergency flag.
- **W19** `auth.users` has **2** rows, not 1 (one has never signed in, created 2026-09-11). It is a second logged-in identity that can call skill-gap, `bootstrap_user_defaults` and `claim_gemini_key`. Teja decides: delete or ban it. Also confirm signup is off on the live project.
- `authenticated` holds TRUNCATE on the append-only tables (`application_events` etc.). PostgREST can't reach it. `revoke truncate … from anon, authenticated`.

### Contracts / dead wiring
- **W20** `packages/shared-types/src/tables.ts` is missing 4 live columns (`applications.resume_sha256`, `answer_bank.attested_by_human`, `search_preferences.work_authorized_countries`, `gemini_key_state.used_in_cycle`). `EmailEventInsert` lacks 4 fields, and `decide.ts:369-375` escapes with `& Record<string, unknown>`. Every `createClient` is untyped. The header (`:15-16`) still claims "ZERO missing columns" and a "44-edge" graph (live has 47). Fix: generate the types from the live DB.
- **W21** The web keeps its own `EmailEventRow` with `classification: string` (`features/emails/emailSync.ts:28-41`). The `'interview'` branch at `:162` can never match, because that value is not in the enum. Fix: import it from `data/contract`.
- **W22** Five satellite functions — cover-letter, follow-up, interview-prep, referral, skill-gap — have **no caller anywhere**. They have 0 `agent_runs` rows ever, and their tables have 0 rows. Their pages (`/nudges`, `/referrals`, `/skill-gap`, InterviewPrepPanel, the cover-letter badge) promise "will automatically appear". Their deployed copies (10-05 / 10-09) also miss the Gemini 400-key-rotation fix `4327531`. Fix: trigger them from a status-change sweep (per the "automate, don't hand-dispatch" ruling), or undeploy them and hide the pages.
- **W23** Dead code with green tests: `_shared/cover-letter/{cover-letter,prompt}` and `_shared/referral/{referral,prompt}`, about 2,690 lines imported only by their own tests; `matcher/freshness-queue.ts`; table `matcher_eval_cases` (0 rows, no writer, and the planned `export.ts` was never built). **Partly resolved 2026-11-01: both modules deleted** (cover-letter and referral, all 6 files, 2,690 lines; `deno info` over all 17 functions showed no function bundled them). `matcher/freshness-queue.ts` and `matcher_eval_cases` are still open.
- **W24** The Watchlist UI offers `workable`, but scout-ats filters to registered providers (`scout-ats/index.ts:216`), so Workable rows are never polled and never reported. `registry.ts:68-70` claims "the Scout records it", which is false. Fix: drop it from `SELECTABLE_ATS_PROVIDERS` until it is registered.
- **W25** `public.rls_auto_enable()` (event trigger `ensure_rls`) exists live but in no migration. A `db reset` or preview branch comes up without it. Fix: capture it in a migration.
- **W26** job-link-intake imports **web source** (`job-link-intake/index.ts:32`, `handler.ts:38` → `apps/web/src/features/pipeline/rowPipeline.ts`). Web auto-deploys; the function deploys by hand. The two copies match today, but nothing forces it. Fix: move it to `packages/` or `_shared/`.
- **W27** There are two scout implementations: the cron runs `worker/src/cli/scout.ts`, the browser runs edge `scout-ats`. Each re-implements fallback, insert and close, so W12 exists twice. Fix: one shared `runScout()`.
- `pipelineRunner.ts:66-67` counts only `scored` as a matcher move, so a batch where every row is dropped shows "0 advanced". Add `'dropped'`.

### Worker / workflows
- **W28** `apply-kit` ignores the kill switch (no `system_enabled` check in `apply-kit.ts`, `apply-kit-sweep.ts` or `cli/apply-kit.ts`). With the system off it still opens up to 5 employer pages a day.
- **W29** Rows that always fail (robots-refused, no `apply_url`) throw before the kit stamp (`apply-kit.ts:220`), are retried oldest-first (`apply-kit-sweep.ts:131`), and keep apply-kit red every day. Fix: stamp the failure, or skip `robots_refused`.
- **W30** The `DRY_RUN` expression uses GitHub's case-insensitive `==` (`apply.yml:168`). `dry_run=FALSE` runs live, and `APPLYY_CRON_LIVE=TRUE` makes cron live. Guard 1 (`apply_only_id`) still limits it to one row. Fix: compare the raw values with shell `=`.
- **W31** Nothing sweeps independently. `sweep_stale_claims` runs only at applier/agent start (`claim-loop.ts:320`), and not at all while the kill switch is off (`:310-314`). `runBudgetSeconds: 3300` (`run-window.ts:78`) plus setup can exceed `timeout-minutes: 60`, and a killed run strands the row at `applying`. Fix: budget about 3000 s; sweep before the kill-switch return.

### Email tracker
- **W32** It can never classify `offer`: `classifier.ts:25` has no offer outcome, so `decide.ts:184-186` is dead and `interview → offer` is never taken.
- **W33** It ingests the whole inbox (`email-tracker.gs:65,100`, `newer_than:2d` with no job filter). Live: **97/97 `email_events` are `unclassified`, 0 matched ✔ orch**. These include security mail (OAuth grants), and there is still zero evidence the classifier works on real employer mail. Fix: narrow the search, or don't store unmatched unclassified rows.
- **W34** rls-proof's "refuse on a populated DB" check counts rows *under RLS* as a test user, so it passes on prod (`rls-proof/index.ts:181-182`). Inert today (no `APPLYY_RLS_TEST_*` secrets, so it returns 500 first). Undeploy it, or give it its own secret and a check that is not scoped by RLS.

### CI / deploy
- **W35** A `describe()` body that throws drops its tests with `fail 0`, `cancelled 0`, exit 0 (re-tested on Node 24). The edge and web jobs only assert `total > 0` (`ci.yml:155`, `:252`). Fix: fail on any `✖` line, or require total ≥ a committed baseline.
- **W36** Test files are never type-checked: `deno.json` excludes `**/*.test.ts` (80 files), and `apps/web/tsconfig.json` includes only `src` (67 test files). Test doubles can drift from the real types.
- **W37** Nothing records which commit each function was deployed from. `packages/shared-types/src/status-flow.ts` is **runtime** code (`_shared/agent/status.ts:80` `canTransition`), so a "types" edit can silently split prod from main. Fix: a per-function deploy ledger, plus a drift check before each deploy session (the agent's script: `scratchpad/drift.mjs`).
- **W38 (PLAUSIBLE)** A red CI does not block the web deploy; Vercel builds independently. Fix: enable Vercel Deployment Checks on the `ci` checks.
- `worker` `test:e2e` is in no CI job. It may be deliberate (no secrets in CI); decide and document it.

---

## Doc drift found (the docs say something the system no longer does)

| Where | Says | Live truth |
|---|---|---|
| `CLAUDE.md` §1 | "There is **no** `discovered → passed_filters` edge." | The edge exists (human-only, the pasted-link path, migration `20261031200000`). **Corrected in this commit.** |
| `packages/shared-types/src/tables.ts:15-16` | "ZERO missing columns", "44-edge graph" | 4 columns missing; 47 edges (W20). |
| `supabase/config.toml:197,235,242` | "the gateway rejects anonymous calls before any quota is spent" | The anon JWT passes `verify_jwt`; `authorizeCaller` is the only real control (W14). |
| `supabase/functions/_shared/ats/registry.ts:68-70` | "The Scout records it and moves on" | Unregistered providers are filtered out before that branch (W24). |
| `apps/web/src/features/health/HealthPage.tsx:75` | A RUN_WINDOW note is rendered | It is never rendered (W9). |
| ci.yml deno-check comment | "83 == 83" | The assertion computes the count itself; only the comment's number is stale. |

## Resolved during the audit (do not re-open)
- scout-ats was deployed with Workday (v28, 07:15 UTC, byte-identical to `1294acc`) after the migration was applied. 0 Workday watchlist rows, so the deploy-order window caused no failure.
- The scout / keepalive / apply-kit failures since 10-31 were all "Invalid login credentials" from the stale password. GitHub secrets were re-set at 05:55Z; scout and keepalive have been green since. Watch today's applier run and the 12:00 UTC kit run.

## Checked and sound
Every edge the agents request exists live, with the right agent allowed. There are no bare status `UPDATE`s. Every RPC signature matches. Every selected column exists (scanned with a control). All 14 enums match `enums.ts`. The status graph (47 edges) is identical to `STATUS_TRANSITIONS`. RLS is on for all 20 tables, scoped by `auth.uid()`. All SECURITY DEFINER functions pin `search_path=""`, and anon has no RPC EXECUTE. service_role is never used at runtime. Every LLM call goes through the Gemini key pool and honours `GEMINI_MODEL`, and no claim can leak. The browser never sends the agent key. Claim concurrency is safe (`SKIP LOCKED`, `applyy-applier` group). robots.txt fails closed on soft-200 and 5xx. The last 15 CI runs are green.

## Recommended fix order
1. **W5** — zero-fields blocker, before any live submit. Smallest change, biggest blast radius.
2. **W1 + W2 + W3** — one "usable job" predicate in the matcher plus the SR detail fetch. Unblocks the whole SR source and stops wasted Gemini spend.
3. **W14** — one-line `authorizeCaller` in skill-gap, plus a red-on-revert test.
4. **W8** — delete the browser scout fallback.
5. **W4, W12** — applier queue-head starvation; make the scout's silent fallback loud.
6. **W6 + W7** — tracker replay sweep and title tiebreak. Must land before the first real `applied` row.
7. **W9, W10, W11, W13** — health window, dead caps, Vercel ignore, package tests in CI.
8. The P2 backlog, grouped by tier as above.
