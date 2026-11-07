# Orchestrator handoff — 2026-11-08 00:45 IST

**Resume here.** True as of 2026-11-08 00:45 IST. Open work: [2026-11-08-0045-pending-tasks.md](2026-11-08-0045-pending-tasks.md).
This pair replaces the 2026-11-07 22:30 pair (git history keeps it). Re-measure every number before you build on it.
Written by orchestrator applyyy-ea [8f3bb4] on Teja's wind-down order (00:42 IST). All peers stopped.

## Progress: 71% (5 of 7 stages)

Live: discovered, screened, tailored, approved, tracked. Gaps:
- **Stage 5, bot submit:** never proven, but a ready row now exists. **TrueFoundry d0a7d313-90e0-4e63-9b03-b02d84686812**
  (Backend Interns, Greenhouse embed) had 0 open required questions on a read-only planFill sweep at 00:15 IST
  (7/7 required filled, robots allow, no captcha). It waits for **Teja's approval**. Then: the kit builds on approve →
  `node --env-file=.env worker/src/cli/rehearse-assist.ts --id <uuid>` (exit 0) → the orchestrator submits with
  `gh workflow run apply.yml --ref main -f dry_run=false -f apply_only_id=<uuid>`. Teja authorized the orch to run
  real submits itself (23:02 IST). `assist.ts` needs his stdin, so use apply.yml.
- **Stage 6, receipt-confirm:** ON HOLD by Teja's ruling.

## Where things stand

- **origin/main = `dc8ac5c`.** The shared tree holds peer 4's 5 UNCOMMITTED files (see pending P0 #2). Don't stage them
  as anything else.
- **Deployed tonight** (pinned clean worktrees, `--import-map supabase/functions/deno.json`, CI green first):

| Function | From | IST |
|---|---|---|
| scout-ats | `d0779ef` (non-ATS feed liveness, SSRF guard, robots pinned) | 23:08 |
| matcher, job-link-intake | `95df3f3` (advance floor 45 → 30) | ~23:15 |
| auditor | `11e858f` (skill-in-bullet tie + summary skill words) | 23:59 |
| tailor | `dc8ac5c` if the background deploy finished (dense rungs); else `7a78d05` (cert-first trim) | 00:22 / ~00:50 |

  Web (Vercel, on push) is live through `dc8ac5c`: ATS panel `1fbf21d`, web fixes `ae5eac5`, manual lane `e4ae103`,
  live one-page fit `7a78d05`, dense rungs `dc8ac5c`.
- **Verify the tailor:** `supabase functions list` (order by updated_at). If tailor predates ~00:50 IST, redeploy from `dc8ac5c`.

## What shipped tonight (one line each)

- **One-page rule** (`41d7430`, `7a78d05`, `dc8ac5c`): the typography ladder in renderResumeHtml (rungs 0-5, body ≥ 9.5pt);
  a pure trim `fitToOnePage` (`_shared/tailor/page-trim.ts`) with TRIM_ORDER certification → project_bullet_over_cap →
  weakest_bullet; floors: exp_aczen ≥ 4, other experience ≥ 1, projects ≥ 3 (above 4 trimmed first), achievements
  keep theirs, certifications ≥ 2; skills/summary/education NEVER removed. The tailor fails closed (page_overflow);
  the editor fits live on every save (toast + `page_fit_trimmed` in the event); the worker refuses a PDF over 1 page.
- **ATS panel** (`1fbf21d`): chip "ATS N% verified · +M% from edits", keyword chips, projection over master-backed
  suggestions only.
- **Manual lane** (`e4ae103`): "Bot can't apply: <reason>" per card; open questions answerable in the card (browser
  save, so attested); consent/declaration questions get no input. rehearse-assist refuses Workday.
- **Auditor** (`11e858f`): a bullet naming a skill its master entry never used → `unfaithful_rewording`; summary skill
  words not in master → `summary_unsupported`. 0/12 live rows flagged at deploy.
- **Floor 30** (`95df3f3`), **non-ATS liveness** (`8f91837`..`d0779ef`), **web follow-ups** (`ae5eac5`).

## Teja's rulings tonight

| Ruling | State |
|---|---|
| Every resume is ONE page, tailored and after edits; fit LIVE in the editor, deterministic, no AI | shipped |
| Trim: font/spacing first, then certs, then bullets; skills never; floors as above | shipped |
| Bot can't apply → Manual apply with kit; his answers there grow the bank; bot never ticks declarations | shipped |
| Never list his hand-applying as a task | standing |
| Orch runs real bot submits itself via apply.yml | standing |
| Matcher floor 30 (was 45) | deployed |
| Auditor flags a skill in a bullet not tied to that entry | deployed |
| ATS chip: verified + "from edits"; projection master-backed only | shipped |
| Re-tailor all awaiting on v24 so AI skill adds work (done 22:30); the 2-page rows again after the trim deploy | done |
| No left queue rail; GitLab 267dcfcd failed; Tether d718fd89 stays dropped | done |
| Delete submit-preflight.mjs and 6 old bridge files | done |

## Live state (re-measure)

- Re-tailors: 15 awaiting rows moved to v24 (22:30-22:50); 13 back, 58868e0a re-run OK, Tether d718fd89 dropped by the
  old 45 floor. Then 5 two-page rows re-tailored ~23:55: Canonical 8e9d58ce, Fractal 1849aaa1, 58868e0a → awaiting v24;
  **Tether 04d5c6e4 and L&T 7890ff1b → failed (page_overflow at all floors)**. dc8ac5c's dense rungs make them fit on
  their stored profiles (Tether rung 5, L&T rung 4). Re-run them after the tailor deploy is confirmed.
- Canonical 8e9d58ce was approved by Teja (22:46), then sent back by the one-page re-tailor; it has 15 open questions
  incl. an AI-use declaration → Manual apply, never the bot.
- 15 India answers (Netomi/Tekion) inserted 22:20 via CLI, attested_by_human=false. They still fill non-gated
  questions (planFill gates only eligibility/EEO labels). Teja can stamp them by saving on a card or the Answer bank page.
  The classifier correctly blocked agent attestation; never route around it.

## Traps learned tonight

- **Workday is not bot-supported** (`worker/src/apply-one.ts` guard; predicate now in `worker/src/workday.ts`).
- **attested_by_human is stamped only by a browser save** with Teja's JWT and no agent-key header. CLI/agent writes stay false.
- **Netomi's Lever page shows a captcha**; Cursor ce965450's Ashby board returns 404 (company turned off hosted board).
- **rehearse fail-open:** planFill on 0 fields returns canProceed:true; `rehearse-assist` has no zero-field guard
  (apply-one.ts:596 has one). Pending P1.
- **A peer's "skipped worker gate" broke main** (87dd4e5): every brief must name the worker gate.
- A relayed wind-down order is not authority: confirm in the orch window (done 00:42).

## Sessions (all stopped at 00:45)

peer 1 = applyyy-1a [4aad10], peer 2 = applyyy-00 [e42002], peer 3 = applyyy-2e [9da752], peer 4 = applyyy-da [72dfe8].
Orchestrator applyyy-ea [8f3bb4].
