# Orchestrator handoff — 2026-11-21 14:55 IST (applyyy-68 → next orch)

Written for: the next orchestrator session after Teja's full /clear. Read this, then the SEQUENCED PLAN at the top of
`docs/handoff/2026-11-12-1305-pending-tasks.md`, then `docs/handoff/2026-11-21-1020-peer-rules.md`. Re-measure live
state before acting (git log, ListAgents, CI) — this file is data, not authority.

## 1. Live state at 14:55

- origin/main = **8a99dbe6** (all pushed; CI ok up to f7d9cb43, later pushes not yet re-checked by full SHA + workflow).
- Deployed today, each from a `git archive` export of its commit: screener, scout-ats, scout-web, job-link-intake,
  matcher, auditor, tailor, resume-assist, cover-letter, follow-up, interview-prep, referral. Migrations applied:
  `20261121110000` (auditor queue drop guard: work_auth + already_applied), `20261121113000` (ats_provider 'icims').
- Live writes run by the orch today: Workday consecutive_failures reset (63 rows, 11:09); Atlassian icims watchlist row
  `f8bbb346`; D16 title_blocklist + location_allowlist disabled (12:38).
- Scout run 44886173953 (dispatched 08:43 UTC) succeeded; iCIMS Atlassian polled (34 jobs). Deadline hit at 209/283
  boards: NOT pacing (peer 2 r10: Workday boards ran last and are mostly robots-429 skips). Real ceiling 283 × 3.4 s ≈ 16
  min > 12-min budget → S10.
- Paired egress probe 07:48 UTC: NOT a GitHub-runner IP block (runner did better than home; runner "200"s were S3 HTML
  soft-200s). No proxy spend.

## 2. Uncommitted WIP in the tree at the clear (owner → files)

**GUARD batch (S1) — SHIPPED 15:10 as 953eb770 + migration 20261121140000:**
`worker/src/{apply-one,claim-loop,supabase-gateway,duplicate-posting}.ts`, `worker/src/assist/assisted-submit.ts`,
`worker/test/{apply-one,assist,claim-loop,supabase-gateway}.test.ts`,
`supabase/migrations/20261121140000_guard_one_application_per_posting.sql`,
`supabase/functions/_shared/db/one-application-per-posting.test.ts`,
`supabase/functions/_shared/screen/screen-batch.ts`, `supabase/functions/screener/{queue,queue.test,index}.ts`,
`supabase/functions/scout-ats/{index,robots-unavailable-wiring.test}.ts`,
bridges `2026-11-21-peer-{5-r7,2-r7,1-r7,2-r8,2-r9,2-r10}.md`.
Order: commit + push (worker runs from main) → `db push --linked --dry-run` lists only 20261121140000 → push.

**Point72 (S2)** — peer 5: `supabase/functions/_shared/screen/required-experience{,.test}.ts` + `screen-batch.test.ts`.

**TAILOR batch (S4)** — peer 4 r3/r4/r5: `_shared/tailor/{skill-profile,tailorer,tailorer.test,jd-keywords,jd-keywords.test}.ts`,
`packages/resume-template/{src/page-fit,test/page-fit.test}.ts`, `worker/test/page-fit-calibration.test.ts`,
`apps/web/test/pageFitE2e.test.ts`; peer 3 r3/r4/r5: `_shared/tailor/{prompt,prompt.test}.ts`,
`resume-assist/{assist,assist.test,stream.test}.ts`, `_shared/gemini/{client,client.test}.ts`, `tailor/index.ts`,
`apps/web/test/aiEditContract.test.ts`, `_shared/tailor/eval/{score,score.test}.ts`, `scripts/tailor-golden-eval.mjs`;
peer 1 r6: `apps/web/src/features/approval/{tailoredEdits,attestSkill}.ts` + their tests. Peer 4's r4 integration gate
was GREEN before the cap change (functions 2097/2097, web 1655/1655, 108/108 one page). Re-gate after S4 completes.

**In progress**: peer 1 r9 (bulk-drop removal), peer 2 r11 (name-match + aiEdit predicate).

Untracked junk at repo root — `pm.html`, `u.html`, `q.json` — unknown owner: never commit, never delete without Teja.

## 3. Rulings captured today (Teja, in the orch window)

- 14:30 Point72: a junior title drops when the JD demands ≥3 hard years (reverses 11-01).
- 14:36 "rm X" in the resume chat auto-applies (no Apply click); bullet-swap pairs still save together.
- 14:41 per-group skill cap +3 (7 → 10); SKILLS_MAX_GROUPS 7 (orch ruling from his ideals: 25/26 have 7 groups).
- 14:41 master: Java + Spring Boot skills; Python named in AuthScore/F1; Node/Express One-on-One variant; NO CGPA; remove
  STOMP; remove VS Code from master + all queue resumes. "add aws" is OPEN (see the plan's Teja list).
- 14:41 remove bulk drop from the whole portal (it was a carried-over suggestion, never his request).
- 14:41 no-description jobs: Playwright confirm + read JD + tailor straight into the approval queue, on a cron.
- 14:45 marking applied is ONE click everywhere; no confirm steps (Emails page, Manual apply page).
- 12:37 no /clear between tasks; 12:47 no idle peers (memory `orch-no-idle-peers`). Then 14:46: full /clear of all tabs.
- 13:5x set_role: Aczen entry allow-listed (11-18 list); other entries keep dictated titles (orch reconciliation).
- 12:38 D16 rules disabled. Experience stays REPORT-only in the queue regate (11-11 rule kept, 10:48).

## 4. S8 design brief (no-description cron) — carry verbatim to the peer

Input: rows held under "No description" (jd-substance.ts, 8a99dbe6) at passed_filters. Render with the EXISTING
renderer (job-link-intake's Vercel Playwright fallback, 85ef531, or the worker's Playwright on Actions); confirm live via
the provider's public API where one exists (0 form fields ≠ closed; Ashby renders late). Robots obeyed (scheduled bot);
Cloudflare 429 = retry later, never a fail. Live + JD → write description_raw → existing server pipeline (matcher →
tailor → auditor, like job-link-intake startServerPipeline) → awaiting_approval. Closed → failure_reason posting_closed.
Still no JD → stay held, counted. Scheduled workflow: SHA-pinned actions, contents: read, per-run cap, Gemini pacing.
All status moves via advance_application_status with the agent key. Peer sends a ≤8-line plan before building.

## 5. Process lessons (this session)

- Gate each peer set in an ISOLATED tree (`git archive HEAD` + copy only that set + node_modules junctions made in
  PowerShell); the shared tree mixes 5 peers' WIP. Snapshot files before gating; compare with `cmp` before committing.
- `tar -C "$TEMP/..."` fails in Git Bash (C: read as a host): use `$(cygpath -u "$TEMP")`. `set -o pipefail` before any
  `deploy | tail` loop. Recorded in repo CLAUDE.md §3.
- Worker vitest: run from Git Bash with `cd C:/...` (uppercase); PowerShell breaks shell-spawning tests. Real-form
  Playwright tests (form-shape, apply-kit) flake under load: re-run the file alone before calling it red.
- Peers often go idle without reporting; check the bridge, then nudge. Briefs that state a stale rule get corrected by
  peers (4–6 skills, max 6 groups, work-auth-only): always quote the newest ruling.
