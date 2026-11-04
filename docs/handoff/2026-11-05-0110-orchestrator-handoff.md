# Orchestrator handoff — 2026-11-05 01:10 IST

**Resume here.** True as of 2026-11-05 ~01:10 IST. Open work is in
[2026-11-05-0110-pending-tasks.md](2026-11-05-0110-pending-tasks.md). It supersedes the 2026-11-04 21:00
pair, which is in git history (`git show 00ecabb:docs/handoff/2026-11-04-2100-orchestrator-handoff.md`).
Re-measure every number before you build on it (CLAUDE.md §2: a handoff is data).

## Where things stand

- **origin/main = local main = `bdd5766`.** Nothing is unpushed.
  - CI for `bdd5766`: success.
  - CI for `8ab943d` (run 41897081392) was still running at handoff. Read it with
    `gh run list --commit 8ab943d53c33edaba6f039db39aa7293215fc9f4 --workflow=ci.yml`.
- **All 7 sessions were stopped at 01:00 IST on Teja's order**, and Teja is closing every window,
  including the orchestrator (applyyy-32).
- **44 uncommitted files on purpose, NOT abandoned (CLAUDE.md §2).** None had finished its gates, and a
  WIP commit is forbidden. Each owner and the exact next step are in pending items P1-1, P1-2 and P1-3.

| Owner (session) | Work | Paths |
|---|---|---|
| peer 3 (82) | Approve re-check, add_skill rule, Fit chip (14 paths) | `apps/web/src/features/approval/{aiEdit.ts,AiEditPanel.tsx,ApprovalQueuePage.tsx,DiffView.tsx,DiffView.css,queueView.ts,approveCheck.ts(new)}`, `features/pipeline/DrawerAppCard.tsx`, `apps/web/test/{aiEdit,approvalQueueView,approvalQueueToolbar,pipelineViewResume,approveCheck(new),approveRecheckE2e(new)}.test.ts` |
| peer 4 (dc) | Emoji removal (25 paths) | `apps/web/src/app/{CommandPalette.tsx,CommandPalette.css,Toast.tsx,SourceBadge.tsx}`, `features/emails/EmailMonitoringPage.tsx`, `features/pipeline/{DiscoveryModal.tsx,DiscoveryModal.css,PipelineDrawer.tsx,PipelineDrawer.css,PipelinePage.tsx}`, `features/settings/{EligibilityAnswers,SearchPreferencesPage,WatchlistPage,AddQuestionModal,FiltersPage,AnswerBankPage,CompanySuggestionsModal}.tsx`, `features/settings/settings.css`, `features/discovery/{DiscoveredJobsPage.tsx,pipelineRunConfirm.ts,PipelineRunModal.tsx}`, `features/followup/FollowUpNudgesPage.tsx`, `features/referral/ReferralOutreachPage.tsx`, `apps/web/test/{noEmoji(new),pipelineRunConfirm}.test.ts` |
| peer 2 (09) | Workday description fetch, part B (5 paths) | `supabase/functions/_shared/scout/adapters/{workday.ts,workday.test.ts}`, `supabase/functions/_shared/scout/{workday-detail.ts,workday-detail.test.ts}` (new), `worker/scripts/workday-backfill-preview.ts` (new) |

- **Safety, verified by the orchestrator at 01:03:** `ApprovalQueuePage.tsx:1121` reads
  `if (to === 'approved' && …)`. The `if (false && …)` that session 74's security review saw was peer 3's
  red-on-revert mutation (live ~1 min, restored). `grep -rn "if (false" apps/web/src/features/approval/` = 0.
- **Leftover worktree with junctions:** `%TEMP%\applyyy-dc-gate` (detached at `bdd5766`, holding dc's 25 files
  + `.env.local`, with 7 `node_modules` junctions into the main tree). **Never recursive-delete it.**
  First unlink each junction with `[System.IO.Directory]::Delete(path,$false)` (PowerShell), then run
  `git worktree remove --force`.

## Live changes made on 11-05 (all verified)

| When (IST) | What | From |
|---|---|---|
| 00:05 | email-tracker-intake **v28**: stored unmatched emails re-matched every run; ATS senders keep their subject | `ce3a565` |
| ~00:25 | Master profile **v15** = v14 minus 2 duplicate "Testing" skills (kept the one under Backend & Systems; Code review, AI, Machine learning kept per Teja). 67 skills. One queue row pinned to v14 is unaffected | SQL insert; triggers set version + hash |
| 00:57 | scout-ats + screener: a blank description is born `dropped_filter` / `missing_description` | `8ab943d` |
| pushes | `f30832e` (docs: dialog rule + referral research), `bc0586d` (Applied page v1 at /applied), `8ab943d` (backstop + sweep log prints failed / by_code), `bdd5766` (tech-stack inventory docs, session 2b) | — |

Live at 01:05: awaiting_approval **47**, approved **13**, scored 15, passed_filters 6, applied 2,
failed 420. 1 email is now matched: Bjak's 10-29 receipt, linked by v28, with 0 status moves, as designed.
Master version 15.

## Teja's rulings on 11-05

- In this window:
  - 00:08: re-check edited rows on **Approve and hold for a second click** ("Approve with these"). Not a hard block, and not the worker.
  - 00:10: **fetch Workday descriptions** for title-passing jobs, including a back-fill of the 391 failed rows (preview first).
  - ~00:20: remove only the duplicate "Testing" skills.
  - ~00:25: write "no native dialogs" into CLAUDE.md §8 (done, `f30832e`); keep + commit the referral research doc (done).
  - 00:40: **run the post-screen drain automatically after every scan.**
- In session 95's window, 00:16: "whenever i approve a job it need to be applied at that time, no daily job
  applie limits at all, keep it unlimited". He chose "GitHub cloud, instant + uncapped" and "Yes, cut CI waste".
- In session dc's window, 00:29: remove all emojis from the frontend.
- In session 2b's window, 00:07: the tech-stack inventory (done, `bdd5766`). 00:59: the 6 security items are
  "dont do now, add them into pendingg list".
- In session 74's window, 00:23: fix the GitHub MCP connection (no repo files; it did not report a half-applied state).
- 01:00: stop everything; save; handoff + pending list.

## Traps learned on 11-05

- **Teja opens sessions directly, without telling the orchestrator.** At 00:55 there were 7 peers, not
  the 3 briefed, plus an unannounced commit (`bdd5766`) and ~30 unowned dirty files. At every resume, and
  before every push: run `ListAgents`, send an ownership check to every unknown session, and map dirty
  files to owners.
- **A red-on-revert mutation is visible to every other session on a shared tree.** Peer 3's
  `if (false && …)` was flagged as a security hole by another session's review. Mutate in an isolated
  worktree, or restore within the same tool call.
- **`agent_runs` has no summary column** (columns: id, user_id, agent, status, started_at, finished_at,
  duration_ms, rows_in, rows_out, error_count, error_detail, gemini_calls). Matcher counters such as
  `pre_gate_dropped_by_code` exist only in its HTTP response, and the sweep log now prints them (`8ab943d`).
- **The Scan popup's "N new applications" counts every inserted row, including rows born
  `dropped_filter`.** Teja's 39 were all dropped (26 tech_gate, 12 unclassified, 1 work_auth). The fix is pending (P1-5).
- **Workday never had a description:** 5612/5612 NULL, because the adapter skipped the detail read on purpose.
  The experience and JD-work-auth gates read `description_raw ?? null` and passed every row (CLAUDE.md §6).
  Both scouts insert Workday: the worker `cli/scout.ts` (main, via scout.yml) and edge scout-ats (the Scan button).
- **GitHub Actions minutes are over budget:** Oct 2,032 vs the 2,000 Free quota (private repo); Nov 1-5
  was 758 (~4,800/mo pace). ci.yml is the biggest consumer. Every new workflow step must be priced in minutes.
- A peer's "Teja said X in my window" is still a relay for authority; it is fine for conventions.
