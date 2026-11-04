# Orchestrator handoff — 2026-11-04 21:00 IST

**Resume here.** True as of 2026-11-04 ~21:00 IST. Open work is in
[2026-11-04-2100-pending-tasks.md](2026-11-04-2100-pending-tasks.md). Re-measure any number below
before you build on it (CLAUDE.md §2: a handoff is data).

## Where things stand

- **origin/main = `ce3a565`.** Nothing is unpushed. CI for it was still running at handoff. Check it with
  `gh run list --commit ce3a565dc777a2bac73f3c836d95b2be13de0c03 --workflow=ci.yml`.
- **Every peer session is stopped and idle** (applyyy-ab, -24, -ec, -f3, -47), and Teja is closing the
  windows. The orchestrator was applyyy-85. Teja ruled it the sole orchestrator at 19:14 IST.
- **Uncommitted on purpose, and NOT abandoned** (CLAUDE.md §2):
  - `apps/web/src/App.tsx` (+1 import, +1 `<Route path="applied">`).
  - `apps/web/src/features/applied/` (`appliedView.ts`, `AppliedJobsPage.tsx`, `Applied.css`).
  - `apps/web/test/appliedView.test.ts` (43/43) and `apps/web/test/appliedPage.test.ts` (26/26).
  These are the unfinished Applied page v1 (peer ec). Its next steps are pending item P1-4. **Any
  commit of App.tsx would sweep in ec's hunk.** Stage App.tsx only when finishing that task.
- Untracked orphan, owner unknown: `docs/design/2026-11-02-referral-outreach-research.md` (pending P3).

## Live changes made today (all verified after the fact)

| When (IST) | What | From |
|---|---|---|
| 19:07 | email-tracker-intake v26 deployed (peer f3, Teja's direct one-off go) | `e314e96` |
| 19:34 | `search_preferences.excluded_keywords` for user `0f4b24da` (tejamallam00): 22 → 26 words (+II, III, IV, Architect). "Intermediate" was held by Teja's ruling: he applied to an "Intermediate Backend Engineer" role | SQL |
| 20:27 | resume-assist v8. The web gate went first (bundle `index-C2q_jUsf.js`) | `c734552` |
| 20:28 | migrations `20261102210000` (agent key fails closed), `20261102211000` (rls_auto_enable capture), `20261104193000` (remote_location_policy + experience ceiling = 1) | `b93a936` |
| 20:30 | screener, scout-ats, matcher | `b93a936` |
| 20:33 | migration `20261104200000_gemini_usage_log` (RLS forced, 2 policies) | `fe0912c` |
| ~20:40 | auditor, cover-letter, follow-up, interview-prep, job-link-intake, matcher, referral, resume-assist, scout-web, tailor | `fe0912c` |
| 20:41 | Cleanup SQL: 86 rows → `dropped_filter` (queue 58, scored 28). Events carry `detail.screen = 'bulk_cleanup_2026-11-04'`, groups `work_auth_v2` (75) and `experience_v1` (11). Undo per group via the human edge `dropped_filter → passed_filters` | SQL |
| 20:43 | `pregate-sweep.yml` run 41855425210: 71 dropped, 0 errors, 0 Gemini calls. Also 358 rows → `failed` (`missing_description`). That is pre-existing matcher behaviour, and all 358 really have an empty `description_raw` (see pending P2-1) | workflow |

Live counts after all of this (20:47): awaiting_approval **43** (was 101), scored 13, passed_filters
35, approved 11, applied 2.

## What shipped today (commits on main, oldest first)

`eb49243` queue search/sort/filter + 4 chips · `fe3642f` no native dialogs anywhere · `f92953a`
CLAUDE.md consumer-first deploy order · `6643798` honest AI resume chat · `51a06c1` e2e test 15 flake
(a test race, measured) · `c734552` AI edits auto-apply only when the audit finds them grounded ·
`b93a936` work-auth v2 + experience gate + "Remote jobs" setting · `49cd616` auditor ignores
`master_text` carried in the resume · `fe0912c` Gemini usage logging (W41) · `80102d6` "Match" → "Fit"
in the pipeline drawer · `7ff7427` CLAUDE.md §7 kill switch now fails closed · `9976d2c` experience
preset/default = 1 · `f6d6547` AI-chat edits recorded as such, no "AI" category default, no duplicate
skills · `ce3a565` email re-match every run + ATS senders keep their subject (**pushed, NOT deployed**).

## Teja's rulings today (in the orchestrator window unless noted)

- 19:09 (in ab's window), 19:14: applyyy-85 is the sole orchestrator. Peers report only to it.
- 19:10: work-auth v2 before Gemini logging. f3 finishes the gmail-sync deploy as a ONE-OFF
  exception to CLAUDE.md §3. Delete + gitignore the stray `*-tests.log` files.
- 19:27: resume chat option B (auto-apply only audit-grounded edits; the JD stays in the prompt).
  Title words go into Settings, not into code.
- 19:36: leave "Intermediate" OUT of the title exclusions.
- 20:20: Applied page v1 now (web-only), with manual stage buttons; label `employer_screening` as
  "Shortlisted"; f3 fixes email matching next.
- 20:35: run all three cleanups; set the Early Career SDE preset + default to 1 year; keep email
  subjects from ATS sender domains (all other unmatched mail stays blanked).
- 20:46: stop all peers; write this handoff and the pending list; delete stale handoffs.

## Traps learned today (each one cost real time)

- **`gh run list --commit <sha>` lists every workflow at that SHA.** A pre-gate sweep run was cited as
  "CI green". Always add `--workflow=ci.yml` (now in CLAUDE.md §4).
- **`db push` carries every committed-but-unapplied migration**, not just yours: `210000` and `211000`
  had sat unapplied since 11-02. Always read the dry-run list. A migration timestamped before an
  applied one needs `--include-all`, so W41's migration was renamed `213000 → 20261104200000`.
- **The pregate sweep's log counts only `dropped` and `survivors`, not `failed`.** 358 rows went to
  `failed` and the log was silent. Count by `application_events` after any sweep.
- **Two orchestrators** formed because Teja directed work in a peer's window. A sitting orchestrator
  stands down only on Teja's own line in ITS window (memory `teja-talks-only-to-orchestrator`).
- **`supabase db query` with a `union` of an enum and text fails**: cast `status::text`. The CLI
  returns `text[]` as `"{a,b}"`, not an array (ab).
- **An isolated worktree needs `packages/resume-template/node_modules` junctioned**, or tsc fails
  with a false TS2307 (ab). Create junctions with PowerShell `New-Item -ItemType Junction`; Git Bash
  rewrites `cmd //c mklink`.
- **The web imports `_shared/audit/detector.ts`** (`bulletGroundingGaps`, by relative path). A
  detector change can change the browser's auto-apply gate, so run the web suite too.
- **A peer's "Teja said X in my window" is still a relay.** It's fine for a convention, but never for
  authority (commit, deploy, live write).
