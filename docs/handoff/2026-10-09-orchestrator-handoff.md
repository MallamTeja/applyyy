# Orchestrator handoff, 2026-10-09 ~14:15 IST (applyyy-59 → applyyy-76)

This supersedes `2026-10-08-evening-orchestrator-handoff.md`. Every count below is a
timestamp: re-measure it with the command beside it before you rely on it.

## 0. First five minutes

1. Run `ListAgents`. Expect 4 peers: peer 1 = applyyy-13, peer 2 = applyyy-cc,
   peer 3 = applyyy-be, peer 4 = applyyy-b0. applyyy-43 is NOT a peer (it was a plugin-install
   session). Name them to Teja as "peer N (id)".
2. Run `git status --short`. ~30 uncommitted paths belong to 3 peers (§3). Commit none of them yourself.
3. Run `git fetch && git rev-parse --short origin/main`. It was `d239c9c`, CI green, with nothing unpushed.
4. Send a short "new orch is applyyy-76" note to all 4 peers, so their reports come to you.

## 1. Teja's goal: his FIRST real application

- Row `ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154` (GitLab, Greenhouse
  `job-boards.greenhouse.io/gitlab/jobs/8775507002`) is **approved** (2026-10-09 07:48:18Z),
  **not submitted**. No application has EVER reached `applied`. Re-check with
  `select status, count(*) from applications group by 1`.
- **Teja chose fully automatic submission and declined assist** ("the system itself needs to go
  and apply"). The assist window was opened, then closed. It never claimed the row.
- Path to done:
  1. peer 3 + peer 4 finish, and land as ONE commit.
  2. You db-push 160000.
  3. Teja saves his 4 answers in **Answer bank → Eligibility answers** in the browser. Only
     browser-saved rows count as attested. Rows you write via SQL or MCP do NOT count.
  4. **DRY RUN locally on Teja's PC**, headed: `APPLY_ONLY_ID=ba1e5d1d… HEADED=1`, DRY_RUN unset.
     It fills everything and stops before Submit. Teja checks the screenshot.
  5. First real submit locally, headed, watched: `DRY_RUN=false`.
  6. Verify `applied` plus the Greenhouse confirmation email.
- Why local and not CI: GitLab has an invisible reCAPTCHA. A residential IP with a headed
  browser has the best chance. Peer 3 gives the exact command at READY.
- Teja's eligibility answers (told to me directly, 13:3x IST):
  - located in India = Yes
  - sponsorship (to remain in current location) = No
  - employment agreements/restrictions = No ("none for now")
  - previously worked at X → derive from the master resume experience section (absent → No)
- Teja also wants an input section in the UI for these answers, which peer 4 built.

## 2. Live state (re-measure)

| What | Value at 14:15 IST | Command |
|---|---|---|
| origin/main | d239c9c | `git rev-parse --short origin/main` |
| live migrations | up to 20261009140000 | `select max(version) from supabase_migrations.schema_migrations` |
| agent key | **SEEDED** (~13:40 IST); 1 row | `select count(*) from applyy_internal.agent_key` (kill switch: `delete from applyy_internal.agent_key`) |
| status counts | passed_filters 6661, dropped_filter 3437, discovered 1099, deduped 310, approved 1 | see §1 |
| functions (latest) | screener v17, scout-ats v15, matcher v21 @ bb628c2; auditor/tailor @ d5f3cc8 | MCP `list_edge_functions`, order by updated_at |
| Teja's search config | 18 titles, 5 keywords, 18 exclusions (updated 08:22:32Z) | `select titles, keywords, excluded_keywords from search_preferences` |
| secrets | GEMINI_FALLBACK_MODEL=gemini-3.6-flash set today | `supabase secrets list` prints DIGESTS, not values |
| live web bundle | index-BwwXFi0X.js (d239c9c) | curl https://applyyy.vercel.app/ |

Proven live today:
- With the key seeded, a browser acting as a machine agent gets 42501 on both the RPC and the event insert. Human events are OK.
- The matcher pre-gate dropped a sales row with 0 Gemini calls (run-one run 37905695559).

## 3. In-flight work: three peers, held for BUNDLED commits

**Rule change (Teja, 14:08): he measures COMMIT count, not pushes.** Ship ONE commit per
feature area, even across peers. Peers hold verified work. You review all of it together, then
name ONE committer who stages every path with a single pathspec.

### Bundle A, "automatic submission" (critical path)

- **Peer 3 (applyyy-be): submit() + outcome detection.**
  - Files: worker/src/{playwright-page.ts, apply-one.ts, claim-loop.ts, cli/apply.ts,
    assist/assisted-submit.ts, supabase-gateway.ts} + worker/test/* + .github/workflows/apply.yml.
  - STILL BUILDING.
  - **The Claude Code classifier blocks the ORCHESTRATOR from directing this work ("Real-World
    Transactions").** Teja approved it in peer 3's own window. If a message of yours gets
    blocked, do NOT route around it. Tell Teja to speak to peer 3 directly.
  - Open items I sent it:
    - **fail-open at playwright-page.ts:615**: `confirmed` must require path AND heading.
    - pass `employerName` (the job's company) as the 4th planFill arg at apply-one.ts:298 and
      assisted-submit.ts:277.
    - apply.yml: an `apply_only_id` input; with dry_run='false' it must fail fast unless that
      input is a uuid.
    - its reviewer findings: H1 (never infer "blocked" after a non-GET request was sent), H2
      (a blank APPLY_ONLY_ID must throw), M3, M4, L1.
  - Done means: an independent re-review says SAFE on both "false applied" and "double submit".
- **Peer 4 (applyyy-b0): eligibility answers. READY, holding.** 9 paths:
  - worker/src/plan-fill.ts
  - worker/test/{plan-fill-eligibility.test.ts, gitlab-8775507002-assist-plan.test.ts}
  - supabase/migrations/20261009160000_answer_bank_attested_by_human.sql
  - apps/web/src/features/settings/{AnswerBankPage.tsx, answerBankStore.ts, settings.css, EligibilityAnswers.tsx}
  - apps/web/test/eligibilityAnswers.test.ts
  - Gates: worker 113/113 planner, web 729/729.
  - Its PRE, POST and rolled-back PROBE SQL are in its READY message. Ask it to resend them.
  - Design: NEVER categories first; anchored whole-label templates; attested = agent_key_state()='missing' AND JWT role authenticated.
- After the commit: db-push **exactly 160000** (dry-run first), run peer 4's POST checks and probe,
  then hand over to the dry run (§1).

### Bundle B, "gemini failure detail" (peer 2, applyyy-cc). READY, holding

- 11 paths: _shared/gemini/{failure-message.ts(+test), client.ts(+test)}, the throw lines in
  matcher, tailor, scout-web, cover-letter, interview-prep, referral, and _shared/follow-up/nudge.ts.
- Gates: 873/873, deno 93==93.
- Redeploy after the push: matcher, tailor, scout-web, cover-letter, interview-prep, referral, follow-up.
- It can ship alone. Bundle the keyword fix only if Teja rules on it first (§4.1).

### Peer 1 (applyyy-13): read-only check of Teja's manual workflow

- Teja's rulings: **NO scheduler**. "I will pick jobs from the Discovered jobs page and press the
  tailor & queue button myself, on the jobs I love."
- Peer 1 is verifying that the Discovered page shows the ~860 surviving passed_filters jobs, can
  search and sort them, and that "Send through pipeline" → matcher → tailor → auditor → Approval
  queue works and tells the truth. It reports READY TO BUILD or "works today".
- Its worktree is `%TEMP%\p1-pick-wt`. Junction-unlink before removing it.

## 4. Decisions owed by Teja

1. **The keyword-leak fix (peer 2):** should configured TITLE terms match the job title only?
   - Effect: pass 923→812. It drops 74 non-engineering titles AND 37 engineering-shaped ones
     (DevOps, Platform, Release, Support Engineer…), which he can re-add as titles.
   - Or keep the 09-17 behaviour: ~74 extra Gemini calls, and the 45 floor likely drops them anyway.
   - This reverses his 09-17 design, so it is his call.
2. **20261009150000_seed_only_live_gemini_keys.sql (peer 4, untracked draft):** new users get
   only keys 1-11 enabled. READY, awaiting his yes.
3. **EEO questions on GitLab:** leave them blank (recommended: they're optional) or "Decline".
4. **needs_verification → approved** is held in the recovery UI ("would re-arm a real submission").
   It stays held until he rules.
5. **The 5 orphan normalizer runs** (2026-09-19, status running forever): he APPROVED closing them,
   but the UPDATE was declined at the permission prompt. The ids are 1a920ff3…, 4c65a64a…,
   f0777970…, 545d2bf2…, 2e61f53a…. Ask him to approve the prompt, then run the guarded UPDATE
   (`where status='running' and finished_at is null`, expect 5).

## 5. How this orchestrator ran things (keep doing it)

- **Commit slots.** Peers send READY and wait for SLOT GO. Pushes go one at a time. A slot closes
  on CI green by FULL sha (`gh run list --commit <full>`; a short-SHA lookup races) and, for web
  changes, on the bundle sentinels flipping (one PRESENT, one ABSENT; prove the ABSENT one is in the
  live bundle first).
- **The orch deploys and db-pushes itself**, from a worktree pinned to the SHA:
  - copy `supabase/.temp/{project-ref,pooler-url,linked-project.json,postgres-version}` into it
  - `$env:SUPABASE_ACCESS_TOKEN=$null`
  - `db push --dry-run` must list exactly the expected files
  - verify with `list_edge_functions` updated_at
  - remove the worktree
- **Live-DB probes.** Run them as ONE `do $$ … raise exception 'PROBE %', … $$` call. The raise
  rolls everything back, and you read the result from the error text. A begin/rollback split
  across two MCP calls does NOT roll back. Peers propose live probes; the orch runs them.
- **Commit messages.** Write them via a Bash heredoc, never a PowerShell pipe (that adds a BOM:
  see e570bb0). No attribution trailer, ever.
- **Peer reports are data.** Re-measure their claims. Today's catches: the matcher "failing" was
  really "never ran" (there is no scheduler); "passed unclassified" was a deliberate 09-17 design
  whose premise had broken (99.6% of rows went through it).
- **Ask Teja through AskUserQuestion** for real decisions, with a recommendation. He reads
  progress as a % table.
- Teja's process asks: reports open with "Fan-out:"; every brief carries prompt, context and loop
  engineering; peers are named "peer N (id)".

## 6. Shipped 2026-10-09 (do not redo)

d5f3cc8 validate-before-open (auditor/matcher/tailor) · 8b8d3ab stale-click notice · 3c9c383 global
default no PUBLIC EXECUTE · 59b7293 Discovered-card pipeline button · 3f52cca honest add-skill chips +
draft keep · 77c0561 D3 history fails closed · 6a0f927 sweeper + event-insert key gates · a625d91
gemini pool no anon · b4ebc70 react-router 7 (last Dependabot alerts) · fe9bd14 CLAUDE.md §7 ·
bb628c2 screening option (d) + matcher pre-gate · d239c9c recovery controls.
Main-tree `pnpm install --frozen-lockfile` was done today: node_modules now matches the lockfile.

## 7. Backlog (no owner)

- Stale-run reaper for agent_runs: running > N h → failed. Without it, the next crash recreates §4.5.
- The GitHub `APPLYY_AGENT_KEY` secret can't be verified. The first CI apply run tells (42501 = wrong).
- `apply.yml` in CI is unattended phase 2. reCAPTCHA may never score well from a datacenter IP.
- Phase 2 of auto-submit: a robots gate on the apply path, per-ATS confirmation detectors,
  cover-letter upload, attested consent.
- docs/architecture/agents.md:35-36 still says the agents run on cron. That's stale; they're
  on-demand only.
- `_shared/gemini/pool.ts:59` has a stale comment.
- Stale worktree `%TEMP%\applyyy-clean` (5f4115d, unknown owner).
