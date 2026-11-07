# Orchestrator handoff — 2026-11-07 22:30 IST

**Resume here.** True as of 2026-11-07 22:30 IST. Open work: [2026-11-07-2230-pending-tasks.md](2026-11-07-2230-pending-tasks.md).
This pair replaces the 11:40 pair, which replaced the 00:45 pair (git history keeps both). Re-measure every number
before you build on it (CLAUDE.md §2).

Written by orchestrator applyyy-37 [e17aec] at 11:40. Corrected at 22:30 by peer 1 (1a) for orchestrator applyyy-ea,
from facts the orchestrator verified tonight plus peer 1's own live SELECTs at 22:25. Sources: `git log`, live SELECTs,
and the peer bridge files in `C:\Users\tejam\applyyy-handoff-keep\2026-11-07-peer*.md`.

## Progress: 71% (5 of 7 stages)

Goal: one human-approved pipeline that runs end to end for real (discovered → screened → tailored → approved →
submitted → confirmed applied → tracked). These five stages work live: discovered, screened, tailored, approved,
tracked. The gaps:
- **Stage 5, bot submit:** never proven. Every applied row so far was applied by hand. 7 rows are `applied` at
  22:25 IST: the email tracker moved cac40516 `applied → rejected` at 18:59 IST. `worker/src/cli/rehearse-assist.ts`
  proves a row is ready without claiming it; the real run is
  `node --env-file=.env worker/src/cli/assist.ts --id <uuid>`. Teja must run it himself: it opens a visible browser
  and asks y/n on stdin, and the orchestrator's shell has no stdin. The password line in the root `.env` is filled.
  The first bot target is Canonical `8e9d58ce` (Greenhouse). It waits on Teja's approval (pending list, P0 #1).
  **The bot handles Greenhouse, Lever and Ashby, not Workday** (`worker/src/apply-one.ts:481-488` parks a Workday row
  for a human).
- **Stage 6, receipt-confirm:** ON HOLD by Teja's ruling.

## Where things stand

- **origin/main = `8f91837`** at 22:25 IST, plus this docs commit. `8f91837` (scout-ats feed liveness for no-ATS
  rows, peer 2) landed after 11:40; the deploy table below does not show whether it is deployed.
- **Deployed today** (all from pinned clean worktrees, all with `--import-map`). Latest version of each:

| Function | From | IST |
|---|---|---|
| scout-ats | `e053f72` (Workday locations + queue liveness incl. Ashby) | 11:36 |
| auditor | `6526679` (D4 summary numbers, jd_keyword_dropped + keywords[] + ref_path, variants) | 11:29 |
| matcher | `35cc880` (N1 text, AWS/Azure, top-level `reason`, legacy key dropped) | ~11:12 |
| tailor | `35f1d4a` (D1 invented-skill drop, D2 ≥3 groups, variants) | 11:00 |
| resume-assist | `1866e7f` (server decides add_skill's group; one general system prompt) | 10:36 |
| screener | `301c5f6` | 09:42 |

  The web auto-deploys on push; everything through `bbfb872` is live there.
- **Master profile = v24.**
  - v20: +AWS, +Microsoft Azure.
  - v21: Teja's UI save.
  - v22: 10 skill groups (ids unchanged; the skills "AI" and "Debugging" deleted).
  - v23: +HTML, +CSS.
  - v24: 3 `summary_variants` (variant-ai-llm, variant-backend-fullstack, variant-ml-data).
  - Build every master write on the highest version. The DB triggers assign `content_hash`, so insert 'pending'.
- **Live counts at 22:25 IST:** passed_filters 22, scored 59, awaiting_approval 15, approved 5, applied 7, rejected 1,
  failed 88. The approved rows are Tether 04d5c6e4, L&T 7890ff1b, Broadridge afc4e657, EA 3f87ad01 and Fractal 1849aaa1.
  None can be bot-submitted: Broadridge and Fractal are Workday (hand-apply lane), and Tether, L&T and EA are non-ATS rows.
- **GitLab 267dcfcd** was set to `failed` at 22:13 IST (posting_closed).

## Teja's rulings today (all applied)

| Ruling | State |
|---|---|
| Peers own whole features; the orch doesn't micromanage; maximum fan-out | Applied all day |
| Approval queue: no manual edit controls or data dumps; AI chat is the only edit path | `7211fd7` |
| Redesign D1–D4: keep "Keep it, I can defend it"; "Changes by AI (N)" with Reset; one facts line; Reject behind InlineConfirm | `7211fd7` |
| Manual apply resume previews start collapsed | `e3e6527` |
| N2: UK/US-only pay band = a chip, never a drop | `d5247b4` + `7211fd7` |
| JD keyword dropped by the tailor = an auditor finding, row to individual review (option A) | `2f65404`, deployed |
| Tailor D1 drop invented skills / D2 top up to 3 groups / D4 summary numbers must trace | `35f1d4a`, deployed |
| Skill groups: option C (10 groups) | master v22 |
| Summary variants: all 3 | master v24 |
| Applied page v2: skip all three items | nothing built |
| HackerRank cb64a4bf: skip (semester overlap) | stays failed |
| No re-tailor of existing rows after master edits | standing |
| Peers start every new task fresh (/clear); retire this peer set and start new peers | memory `peer-fresh-context-per-task` |
| Evening: no left queue rail; the approval page stays 2 columns | nothing to build |
| Evening: a master skill in a bullet not tied to that experience = auditor finding, row to review | ruled, NOT built |

## Live writes today (orchestrator, on Teja's word in its window)

- **09:36:** Dubai 0cccc73a and GE dfa046be dropped; Gushwork 207dd30d set to applied.
- **09:36:** pre-gate sweep dropped 16.
- **09:49–10:00:** re-tailor of 13 rows. Micron c4ab09d0 failed at the auditor re-gate (5 years required).
- **10:15:** 2 PayPal dropped (US only); FIS + 5 Greenhouse rows failed (posting_closed).
- **10:39:** HTML backfill of 448 feed descriptions, plus 1 footer row at 10:52.
- **10:50:** Thoughtworks and Wells Fargo dropped.
- **Master writes:** v20 (09:55), v22 (10:47), v23 (11:08), v24 (11:20).
- **11:31:** Enterpret cfe8b0f5 set to applied. Teja submitted it by hand.

## Traps learned today

- **supabase-js `signOut()` defaults to scope 'global'** and revokes EVERY session of the user, the browser included. The
  orchestrator's 11:04 rehearse run did this, and the AI chat then answered `invalid_session` (401 from gates.ts:74).
  Fixed: rehearse now uses `scope:'local'` (`6594a38`), and the web's Sign out is local too (`bbfb872`).
  `applyyy-handoff-keep/submit-preflight.mjs`, which signed out globally, was deleted at 22:08 IST.
- **`attested_by_human` is stamped ONLY by a logged-in browser save.** A write without the agent-key header from the CLI
  or any other client does not stamp it. The 11:40 handoff said otherwise. The India answers were written by CLI at
  22:20 with `attested_by_human = false`, so Teja must Save them on the Answer bank page.
- **A rehearsal can pass most checks on a row the bot will refuse.** `rehearse-assist.ts` has no Workday refusal. On
  Broadridge and Fractal only the empty kit made it exit 1. Check the ATS host first.
- **A bulk status move swallows Teja's clicks.** The 09:49 re-tailor moved rows while he was approving, and his approvals
  never landed. Warn him first (memory `applyyy-bulk-move-warn-teja-first`).
- **Committed ≠ deployed, again:** the tailor retry (11-05) only went live 11-07 04:12.
- **The handoff said Enterpret 30889f9e awaited the first bot submit;** Teja had applied by hand at 00:40. Check
  application_events before acting on a handoff's row state.
- **The auto-mode classifier blocks some live UPDATEs** (it blocked the 448-row backfill until Teja said yes again in
  the window). Never route around it.
- **`gh` has transient api.github.com timeouts here.** A background deploy chain failed on one; re-run it, don't assume.
- **Gate in an isolated worktree** (origin/main + your files). The shared tree always has a peer mid-edit.

## Sessions

Evening set (orchestrator applyyy-ea; Teja named the windows himself):
- peer 1 = 1a: first-bot-submit recon (DONE), then this docs cleanup
- peer 2 = 00: scout-ats, non-ATS liveness probe
- peer 3 = 2e: apps/web follow-ups

Morning peers (all DONE and retired):
- peer 1 = applyyy-1f [32479f]
- peer 2 = applyyy-c9 [4c1611]
- peer 3 = applyyy-41 [140606]
- peer 4 = applyyy-f4 [528bf0]

applyyy-96 [5518b6] is the old orchestrator 9f, stood down at 09:26.
