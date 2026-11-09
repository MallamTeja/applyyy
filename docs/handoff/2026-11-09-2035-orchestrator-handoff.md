# Orchestrator handoff — 2026-11-09 20:35 IST

**Resume here.** True as of 2026-11-09 ~20:35 IST. Open work: [2026-11-09-2035-pending-tasks.md](2026-11-09-2035-pending-tasks.md).
This pair replaces the 2026-11-08-1745 pair. Written by orchestrator applyyy-ae [fceaac] on Teja's wind-down ("i have
closed all the peers"). Peer bridges: `C:\Users\tejam\applyyy-handoff-keep\2026-11-09-peer*.md` (the newest file per
peer has its last task).

## Progress: 71% (5 of 7 stages)

Live: discovered, screened, tailored, approved, tracked. The gap is stage 5, the bot submit, which is still unproven.
TrueFoundry d0a7d313 is `awaiting_approval` and pre-flight checked 8/8 (docs/status/2026-11-09-stage5-preflight.md).
It is waiting on Teja's click. Stage 6 (receipt-confirm) is on hold.

## What shipped today (all on main, CI green at every SHA)

| SHA | What | Deployed |
|---|---|---|
| ae2d1bb | tombstone batch 250 + halving on 57014; readWaitingCounts deleted; SCHEMA_CONTRACT | worker (runs from repo) |
| a3ef168 | headline cleaner (role phrase, singular, trailing Intern); drop applications.ats_keyword_coverage | tailor; migration applied |
| c8d0cd9 | Approval queue parallel master + pool of 4; Discovered reads description_preview (option B) | web; migration 20261108170000 applied 16:40 |
| 7fcc6ed | **post-screen drain is AUTOMATIC** (after each scout via workflow_run + cron 04:30 UTC; Teja reversed his 11-05 manual-only ruling ~17:20); stage stall no longer skips later stages; matcher 5 s pacer (≤12 RPM) | matcher |
| 2afaa99 | xAI greenhouse board reports "SpaceXSI" → board-scoped identity alias | **NOT deployed** (scout-ats held, see pending P0-1) |
| cb58582 | self-hosted fonts + CSP font-src 'self'; Ashby "closed" comes from the public posting API; no-email-field form → Manual lane; `->failed` requires p_detail.reason (migration 20261109180000) | web; migration applied ~18:12 |
| e99b758 | uncited model summary repaired, not refused (9 rows failed on it today); tailor + scout-web write gemini_calls; repo-wide guard test | tailor, scout-web |
| b4f1661 | /approvals first paint drops description_raw (−438 KB, deferred read); agent_name 'scout_web' | web; migration 20261109190000 applied; scout-web |

Every migration went through a pinned worktree with `db push --linked --dry-run` listing exactly the expected file.
Prod web checked on cb58582 (woff2 content-type, CSP, Google css2 absent, preload present). b4f1661's prod sentinel was
NOT checked (do it: the /approvals page chunk's queue select must not contain `description_raw` in its first read).

## Live state (re-measured 20:33 IST; re-measure before you build on it)

- Status counts: awaiting_approval 88, failed 91, applied 8, rejected 1, dropped_filter 35,932. scored and
  passed_filters are both 0.
- The auto-drain works: scout (ats) 12:50 UTC → post-screen drain `workflow_run` 13:02 UTC, success.
- xai: 0 new jobs today, 291 total. No duplicates: the deployed scout-ats and worker scout still refuse the board.
- Notable rows: d0a7d313 TrueFoundry awaiting_approval (the first bot submit). 8f20a220 Supabase is
  awaiting_approval again (re-tailored on v27 after Teja withdrew his approval; jobicy has no form, so he applies by hand on
  Supabase's site). ce965450 Cursor awaiting_approval: its posting is LIVE per Ashby's API, but the hosted board 404s,
  so a resume-only kit goes to the Manual lane. 060162ca (score 92) is failed, waiting on the recovery SQL (P0-4).
- Master v27. Live Gemini model = the GEMINI_MODEL secret.

## Teja's rulings today

| Ruling | State |
|---|---|
| Withdraw 8f20a220's approval and re-tailor | done |
| Headline: approve existing rows as-is, fix the cleaner, keep a trailing "Intern" | shipped a3ef168 |
| Drop ats_keyword_coverage | shipped + applied |
| Run the drains now; drop 4 disappeared scored rows; recover 9 group-A failed rows | done |
| **Reverse the 11-05 manual-only drain → auto-drain on** | shipped 7fcc6ed |
| **"Don't ask question menus, just do pending work"** (17:40) | memory `orch-decide-dont-ask`. Approvals, classifier blocks and reversing his own rulings are excepted |
| Mumbai region move | RECOMMENDED by the orch (fresh load 1.41–1.78 s → ~0.5–0.64 s modelled); **Teja has not ruled** |

## Decided by the orch (reversible)

No Workday description backfill job (23/24 targets are closed postings; the scouts fill new rows at insert). No
disappeared_at back-fill (it self-clears by ~11-18; the SQL is in docs/status/2026-11-09-disappearance-gap.md). No tailor
pacer (1 of 203 runs hit a 429). The Supabase CLI stays on v2 (CLAUDE.md §3). Cursor is not dropped (API-listed).

## Traps learned today

- **The classifier blocks orch-run live data writes** ("Modify Shared Resources") unless Teja approved that exact move
  in-window: the xai re-key, the failure_reason back-fill, the 9-row recovery and the aiven disable were all blocked.
  `db push` and deploys were allowed. Never route around it; queue it for Teja.
- **An HTTP status is not "closed" evidence on Ashby.** Cursor's whole hosted board 404s while the API lists the
  posting. Ask the ATS API.
- **The deployed function ≠ the committed one**: holding a deploy keeps the old behaviour live (the scout-ats xai alias).
  The worker runs from main, so holding its commit is the only hold. That's why worker/src/cli/scout.ts is uncommitted.
- **A guard can pass on a comment**: the gemini_calls guard first passed because a comment named the field. Strip
  comments, assert the written key.
- **Old e2e mocks returned description_raw whatever the select asked**, so a deferred read looked tested while never
  running. Mocks must honour `select`.
- **Playwright waitFor quantizes timing** (≤500 ms back-off) and faked "page-ready unchanged". Stamp in-page.
- **$TEMP is shared across sessions**: a peer's q1.sql was overwritten mid-run. SQL scratch goes in the session scratchpad.
- **The drain needs no dispatch now**: passed_filters rows get drained after the next scout run or at 04:30 UTC.

## Sessions

All peers closed by Teja ~20:30: peer 1 = applyyy-fe [c01283], peer 2 = applyyy-09 [fc5353], peer 3 = applyyy-89
[f2e05e], peer 4 = applyyy-a9 [7abe27]. Orchestrator applyyy-ae [fceaac]. Run `ListAgents` at resume; ownership-check any
unknown peer before pushing.

**Uncommitted in the tree, on purpose:** `worker/src/cli/scout.ts` (+3/−2) and `worker/test/scout-board-identity.test.ts`
(peer 4, gated: worker tsc 0, vitest 736/736). Commit ONLY after the xai re-key runs (P0-1). `apps/web/results-time.json`
is a stray measurement file (not anyone's deliverable; leave it or ask Teja).
