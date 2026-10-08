# Orchestrator handoff — 2026-10-08 evening (applyyy-22, ~18:00 IST)

Teja killed every session at ~18:00 IST. **This file is the resume point.** It supersedes
`2026-10-08-orchestrator-handoff.md` (df, af9eb2c), which stays authoritative ONLY for the
agent-key hash and the assist command (its §3), both quoted below.

Every count here is a timestamp. Re-measure with the command beside it before relying on it.

---

## 0. Before you touch anything

1. `git status --short` and `git worktree list`. The tree holds **uncommitted, unfinished work
   from three peers** (§3). "Uncommitted" ≠ "abandoned": each block below says who owned it and
   how finished it is. Don't commit a block until it has been re-verified.
2. `git log origin/main..main`: was EMPTY at 17:56 (origin/main = `8d7430b`).
   peer 2's (d0) freeze report said `8d7430b` was unpushed and "not mine". **That was stale.**
   `8d7430b` is peer 4's (36), it IS on origin, and its ci.yml edit was an orch-granted carve-out
   of d0's partition.
3. Main-tree `node_modules` still holds vitest 2 / source-map-js 1.2.1, while the lockfile
   (cf8699a) says vitest 4.1.11. **Don't `pnpm run` anything** (pnpm 11 runs an implicit install)
   until the orchestrator schedules a `pnpm install` with every peer idle.

---

## 1. Teja's first real application: still the #1 goal

- Row **`ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154`** (GitLab), status `awaiting_approval`.
  Check: `select status, updated_at from applications where id='ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154'`.
- Teja approves it in the web UI. The inline editor is live and QA-verified (§4). This job has
  **zero** "+ Add" skill chips, which is correct: none of its missing keywords are in master v2.
- Then Teja runs, in a NEW PowerShell window:
  `node worker\src\cli\assist.ts --id ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154`
- Then verify `applied`, and only THEN seed the agent key (orch, live write):
  `insert into applyy_internal.agent_key (key_sha256) values ('173cffbd0242d72a9d5bb98b993637269d4a3ea0f4e8217686a4e8bc3850d9ce');`
  Then verify that the next machine transition doesn't raise 42501.
  Kill switch: `delete from applyy_internal.agent_key;`
- After the first application: rotate the app password in 3 places (df's handoff §3).

## 2. Live state at 17:56 IST (re-measure)

| What | Value | Command |
|---|---|---|
| origin/main | `8d7430b` | `git rev-parse origin/main` |
| CI on 8d7430b | **in_progress** (run 37776837340), close condition: e2e 10/10, fail 0, cancelled 0 in the log | `gh run list --workflow ci.yml --commit 8d7430b` |
| Latest migration live | `20261008190000` | MCP `list_migrations` |
| Deployed today (pinned worktrees) | screener v15, normalizer v13, matcher v19 @ c2c7a0c (12:16Z); scout-ats v13 @ 05a9df0 (12:06Z) | MCP `list_edge_functions` (order by updated_at) |
| Status counts | passed_filters 6509, dropped_filter 3361, discovered 1099, deduped 310, awaiting_approval 1 | `select status, count(*) from applications group by 1` |
| Web bundle | index-Dzcnizps.js (cf67c9f+). 8d7430b changes only tests/CI | curl https://applyyy.vercel.app/ + grep sentinels |

**Pushed today by this orchestrator's peers:** 79ad9b5, 1821881, c3195b2 (resume editor), cf67c9f
(drawer "Send through pipeline"), 05a9df0 (signup seed + screener committed-history),
cf8699a (deps: vitest 4, source-map-js), c2c7a0c (normalizer fail-closed lookup, matcher stamp
guard, screener validate-before-open), 8d7430b (e2e fails loudly).

## 3. Uncommitted work in the tree: per owner, per readiness

### A. Peer 2 (d0): validate-before-open for auditor/matcher/tailor. **READY, verified.**
Paths (6):
- supabase/functions/{auditor,matcher,tailor}/index.ts
- supabase/functions/normalizer/index.ts (comment only)
- supabase/functions/_shared/http/application-id.ts (header)
- supabase/functions/_shared/http/application-id.test.ts (+3 ordering tests)

What it does: each agent parses `?application_id` with `parseApplicationIdParam` BEFORE inserting
its agent_runs row, so an invalid id → plain 400 and no `failed` run on Health.

Gates (17:55):
- node --test supabase/functions/**: 832/832, 0 fail, 0 cancelled
- deno: 92 == 92
- red-on-revert by name for each of the 3 ordering tests
- independent review PASS-WITH-NITS
- NOT run: CI

**Next:** pathspec-commit the 6 → push → CI green → orch deploys auditor + matcher + tailor.
Matcher: c2c7a0c's stamp-guard lines are untouched (3 hunks only).

### B. Peer 1 (68): Discovered-card "Send through pipeline". **PARTIAL, mid-edit.**
Teja approved the feature at 16:08.
- DONE:
  - apps/web/src/features/pipeline/{rowPipeline.ts, PipelineDrawer.css}
  - apps/web/src/features/discovery/DiscoveredJobsPage.css
  - apps/web/test/rowPipeline.test.ts
- PARTIAL:
  - apps/web/src/features/pipeline/DrawerAppCard.tsx: review fixes: label/aria-label, card aria-live when onSettled is set, matcher drop wording
  - apps/web/src/features/discovery/DiscoveredJobsPage.tsx: silent refresh + request-sequence guard in loadData; skip reload on null; strip rendered only when non-empty. Check that nothing passes loadData as an event handler.
  - apps/web/test/discoveredSendPipeline.test.ts (new; the onSettled-after-release test may be half-written)
  - apps/web/test/discoveryNoFastPath.test.ts (regex tightening, .update/.insert ban)

Gates: green only on the PRE-fix-round copies (tsc 0, web 592/592, e2e 10/10). Those copies are
in `%TEMP%\p1-68-wt` and in peer 1's scratchpad `...\673a8f0f-e339-48e3-8b4b-debb2ad553f6\scratchpad\t2`.
**The main tree is newer and UNVERIFIED.** The review had no blockers: 3 should-fix, which are the PARTIAL items.

**Next:** re-read the 4 partial files, finish the fixes, re-gate in an isolated worktree, run the
faked-supabase render check, then commit.

### C. Peer 3 (e8): approval page. Two tasks, kept apart.

**(B) "A stale click must not be silent." DONE + VERIFIED, not committed.** Paths (4):
- apps/web/src/features/approval/ApprovalQueuePage.tsx
- apps/web/src/features/approval/ApprovalQueuePage.css
- apps/web/test/approvalStaleClick.test.ts (new, 15 tests, red on HEAD)
- apps/web/test/approvalBucketMoveFocus.test.ts (one assertion narrowed)

Gates:
- 2 independent reviews, no blockers
- approval suites 92/92, 0 fail, 0 cancelled
- red-on-revert by name
- browser render S1–S4 PASS
- tsc 0 in an isolated worktree
- **NOT yet run on the final version: vite build + the full web suite.** The previous version passed 593/593.

Sentinels: PRESENT `queue__stale-notice`, ABSENT `Review the current version.`

**Next:** isolated worktree (copy apps/web/.env.local in) → vite build + full suite → commit.

**(C) Skill-chip over-offer (the §4 QA bugs). PARTIAL; may not compile.**
- apps/web/src/features/approval/tailoredEdits.ts: `addableSkillFor` reworked to token equality. The matrix was 51/51 before the alias follow-up.
- apps/web/src/features/approval/diffAdapter.ts: **MID-EDIT**, certification-coverage helper half-wired.
- apps/web/test/addableSkillMatrix.test.ts (new, 51 cases, red on HEAD 8/51): done.
- Not started:
  - keep the draft on a refused save (DiffView.tsx)
  - pane-specific preview button names (resume-preview/*)
  - the "Postgres" alias rule
  - 5b: focus to the edited line after save (needs (B) landed)

**Queue after (C):**
1. Silent paths, in order:
   - (c) a row settled elsewhere gets a FALSE "changed elsewhere" toast. Reachable, the worst.
   - (b) the batch button drops in-flight ids silently.
   - (a) wording only: a missing updated_at is unreachable (column not null + trigger).
2. Then move the render harness into apps/web/test/render/: **local-only, not CI** (e2eSuite already covers chromium on CI).

Peer 3's scratchpad (render scripts check.mjs/t23.mjs/t-stale.mjs + README):
`%TEMP%\claude\c--Users-tejam-OneDrive-myproj-applyyy\7cdc0e19-1164-4655-95fe-b6ca465e8133\scratchpad\render\`.
Its `t1\` holds **live personal-data dumps: never commit.**

Worktree `%TEMP%\e8-B-wt` (c2c7a0c) holds no unique work. Junction-unlink first, then remove.

## 4. QA evidence: resume editor on the live site (orch subagent, 17:46, 0 live writes)

- PASS: real row loads, inline edit (single-path PATCH guarded by updated_at), cancel/Escape,
  stale lock (0-row PATCH and PT409 both told to the user), add/remove/reset skill exact
  round-trip, zoom 0.3–1.5 + Fit, keyboard path.
- FAIL, the skill-chip honesty guard (tailoredEdits.ts `addableSkillFor` uses substring matching both ways):
  - "SQL Server" offers "+ Add SQL"
  - "Engineering"/"Context"/"Calling" offer the multi-word skills that contain them
- Low:
  - certifications don't count toward coverage
  - a refused save discards the draft
  - duplicate zoom-button names across the panes
  - focus after a save goes to the card heading
- Harness + matrix: orch scratchpad
  `C:\Users\tejam\AppData\Local\Temp\claude\c--Users-tejam-OneDrive-myproj-applyyy\c2e09f46-fd06-40e7-8dc8-ad694d7b4a72\scratchpad\qa-editor\`
  (s6.mjs = chip matrix; harness.mjs = fake-session; every supabase.co request fulfilled locally).
  **Temp dir: copy it into the repo before it's needed if it matters.**

## 5. Decisions owed by Teja

1. **Screener run on the 310 `deduped` rows.** The new code is deployed and unexercised.
   - Recommended: canary first (`screener?application_id=<one deduped id>`), then all.
   - Proof query (peer 4): screener `application_events` deduped→passed_filters after 12:16:21Z > 0, AND a screener agent_runs row with rows_out > 0. If rows_out = 0, read error_detail.
   - Counter-check: no `already_applied` drops.
   - Nothing schedules the screener. Don't run it without Teja.
2. New-user seed enables 20 Gemini keys; keys 12–20 are dead (403). Seed only 11?
3. The B2 signup trigger can't be dropped by a migration (supabase_auth_admin owns auth.users). Accept; change behaviour via CREATE OR REPLACE.
4. The 390px Approve bar takes 18% of the viewport.
5. Rotate the app password after the first application.

## 6. Backlog (nobody owns it now)

- Security, CLAUDE.md §7: `advance_application_status` trusts the caller's `p_agent`; EXECUTE is granted to anon/authenticated.
- New functions in `applyy_internal` still default to PUBLIC-executable. A global `alter default
  privileges … revoke execute on functions from public` would fix it but also reaches public RPCs, so it needs scoping.
  20261008160000:118-120's comment claims protection its statement never gave (documented in 190000's header; old migrations aren't edited).
- D3: screener committed history truncates silently above PostgREST max_rows=1000 (live 0 today).
- react-router 6→7 (#35/#36, the last Dependabot alerts): ~1h, 5 files + package.json + lockfile window.
- filter_rules: 9 rows for each of 2 user_ids; only 1 user has applications. Find the orphan's owner.
- ruleWarnings.ts header names only the old .slice(0,1000) layout.
- GEMINI.md audit findings (mis-scoped "global", "don't ask confirmation" contradicts repo rules, deletes handoffs, incomplete git rules). Orch/Teja to fix.
- Stale worktrees:
  - `%TEMP%\applyyy-clean` (5f4115d, unknown owner, old)
  - `%TEMP%\p1-68-wt`: 8 node_modules **junctions**. Unlink each with `[System.IO.Directory]::Delete(path,$false)`, confirm the real apps/web/node_modules still has 13 entries, THEN `git worktree remove --force`. A recursive delete wipes the real node_modules.
  - `%TEMP%\e8-B-wt` (see §3C).
- Session `applyyy-80` was alive and idle at 17:56; nobody assigned it work. Purpose unknown.

## 7. Process rules this session ran on (keep them)

- **Commit slots:**
  - Peers send READY and wait for SLOT GO. Pushes go strictly one at a time.
  - A slot closes only on CI green on the SHA AND, for web, a PRESENT + ABSENT bundle sentinel flip.
  - The 30-min spacing was suspended 17:24 by Teja.
- **Deploys and db pushes are orch-only:**
  - clean worktree pinned to the SHA
  - `$env:SUPABASE_ACCESS_TOKEN=$null`
  - `db push --dry-run` must list exactly the expected files
  - verify by updated_at
  - PowerShell 5.1: no `*> $null` on `git worktree add` in a conditional (it sets `$?` false and skips the block)
- **Briefs carry prompt/context/loop engineering and mandate fan-out.** Reports open with "Fan-out:".
- **Lessons from today:**
  - Check that a path is reachable before ranking a bug (peer 3 corrected the orch).
  - Never relay a peer's claim to Teja unverified (the pgvector "Add chips" came from fixtures, not the live row).
