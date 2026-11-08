# Orchestrator handoff — 2026-11-08 17:45 IST

**Resume here.** True as of 2026-11-08 ~17:45 IST. Open work: [2026-11-08-1745-pending-tasks.md](2026-11-08-1745-pending-tasks.md).
This pair replaces the 00:45 pair (git history keeps it). Written by orchestrator applyyy-2a [8b9dc0] on Teja's
wind-down order (17:37). Peers stopped; their bridges are in `C:\Users\tejam\applyyy-handoff-keep\2026-11-08-1745-peer{1,2,3}.md`.

## Progress: 71% (5 of 7 stages)

Live: discovered, screened, tailored, approved, tracked. Gap: stage 5, the bot submit, is still unproven.
TrueFoundry d0a7d313 is re-tailored, QA-passed and waiting for Teja's approval (pending P0 #3). Stage 6 is on hold.

## What shipped today (commits on main, all CI green unless noted)

| SHA | What |
|---|---|
| 2936e8c | kit rebuild on answer save (dispatch-apply `kit_only`), "Fitted to one page (smaller type)" preview hint |
| a974786 | rehearse-assist fails closed on 0 fields; N2 pay band amount-first; status docs |
| e445e06 | Teja's content rules: ≤2 projects (≥4 bullets), Aczen ≥4, certs ≥3, achievements ≥2, education ≥2, summary on every resume, headline = role title; enforced at tailor, editor save, auditor pre-gate |
| 425423d | achievements \| certifications side by side; blue links clickable in every PDF; mailto fixed; preview links open outside |
| af2c45b | applyy always one of the 2 projects; email-tracker replay 938 ms → 5 ms |
| 1f48cd7 | web: health 43→10 requests, counts from RPC; migration 20261108170000 (NOT applied) |
| (final bundle) | web latency (approval queue, React.lazy routes, Manual apply lazy, InlineConfirm), handoff, stale docs removed |

**Deployed** (pinned clean worktrees, `--import-map`): dispatch-apply (e445e06), tailor + auditor (425423d, then
af2c45b), email-tracker-intake (af2c45b). Web auto-deploys on push (prod verified current at 425423d by sentinels).

## Live state (re-measure)

- **Master v27 live** (17:13 IST, hash 89f8b178…): formula bullets with Teja's numbers, Data Science group (16
  skills), applyy GitHub link, "Testing & Quality" removed, ai-llm variant "18 functions / 12 agents". The backend
  variant keeps Redis/Socket.IO (Teja: hands-on). 1on1 links to the KEEPER repo, never 1on1_sb (Teja). "50+
  endpoints" and "40 indexes" are Teja's numbers (the repo shows 52 in 1on1_sb, 29 designed in the keeper).
- **Re-tailor running** (17:27 → ~17:53): 21 rows moved to passed_filters by the orch (0 refused) + 5 already
  queued = 26. At 17:38: 9 fit, 1 refused (Cursor, page_overflow), 16 pending. Tether + L&T skipped.
  FIS 8794f52f and LSEG d0bf75bb tagged `manual` (Teja's picks) so the 30 floor can't drop them.
  The 26 ids: d0a7d313 37027b2d 61693261 a06fd6b8 b7eb1ef1 ce965450 f1fa8258 f21fbd88 8e9d58ce 58868e0a 1849aaa1
  8f20a220 a323b808 e5107026 3f87ad01 afc4e657 cb16aa3d 9c26dfc6 4bd46605 8794f52f d0bf75bb 2b7db9a2 3a4df0f9
  d45c3ba6 3c787bb6 b0e93ede.
- The 4 Workday human picks (LSEG Observability, FIS Java, Barclays ×2) will land in Manual apply: the bot doesn't do Workday.
- DocCheck b7ccb314 skipped (German + DACH residency).

## Teja's rulings today

| Ruling | State |
|---|---|
| ONE commit per 15 min, made by the orch; peers never add/commit | standing (memory) |
| Max fan-out: up to 6 subagents per peer, waves, peer re-verifies at fan-in | standing (memory) |
| Never touch the sessions he opens unannounced (applyyy-f4, applyyy-46 today) | standing |
| Resume content rules + applyy always in + summary always | shipped |
| Skills: ≥4 per group, relevant first, topped up | as built |
| Discovered: option B (preview column + server search fallback + degree column), no visible change | migration written, web held |
| Region move: ship code fixes first, measure, then decide | deferred |
| Worktree cleanup yes, but the classifier blocks it | pending Teja |

## Traps learned today

- **CI 504s**: Deno and gitleaks downloads failed with HTTP 504 (GitHub side). Read the failing STEP before
  assuming a code or secret problem; `gh run rerun <id> --failed`.
- **A peer's file can carry another session's edits**: SCHEMA_CONTRACT.md showed +209/-94 vs the peer's +10/-3.
  Always `git diff --numstat` against the peer's reported size before staging.
- **Floors are selection floors too**: trim floors alone let the tailor pick fewer items (8794f52f had 1 Aczen bullet).
- **Slowness = the Sydney region** (ap-southeast-2): ~300 ms per round trip × serial hops; DB time 8-28 ms. Fix hops first.
- **Routes are code-split now**: the prod sentinel check must grep page chunks (CLAUDE.md §4 updated).
- **Classifier blocks**: a live jobs-tag UPDATE was blocked once, then allowed on Teja's explicit retry; deleting
  temp worktrees is blocked even when delegated. Never route around it.
- A blocked Bash command doesn't run ANY of its parts (the scratch file it would have written doesn't exist).

## Sessions (stopped at ~17:45)

peer 1 = applyyy-55 [db5668], peer 2 = applyyy-a3 [c9869d], peer 3 = applyyy-7e [543bc3]. Orchestrator applyyy-2a [8b9dc0].
applyyy-f4 [7e2154] and applyyy-46 [98b700] are Teja's own sessions: never touched. Their uncommitted docs edits
(docs/PROGRESS.md, docs/stack/*, docs/architecture/*, SCHEMA_CONTRACT.md, …) are still in the tree, NOT committed by the orch.
