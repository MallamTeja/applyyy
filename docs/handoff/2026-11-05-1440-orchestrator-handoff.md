# Orchestrator handoff — 2026-11-05 14:40 IST

**Resume here.** True as of 2026-11-05 ~14:40 IST. Open work is in
[2026-11-05-1440-pending-tasks.md](2026-11-05-1440-pending-tasks.md). This pair supersedes the 01:10 pair
([2026-11-05-0110-orchestrator-handoff.md](2026-11-05-0110-orchestrator-handoff.md)), whose open items are all
carried or closed below. Re-measure every number before you build on it (CLAUDE.md §2: a handoff is data).

Teja ordered a full stop at 14:32 IST ("stop everything safely, fan out, make a handoff, stop every peer").
Peers 1 (8b), 2 (8e), 3 (9b) and session 1b were told to stop at a safe point; 1b, 8b and 9b confirmed;
**8e (peer 2) never sent its final report** before its window closed. Peer 4 (d3) was opened by Teja at
14:36 for ONE task (the AI resume-chat bugs, pending P1-4) and may still be working.

## Where things stand

- **origin/main = `1341608`.** CI green on every pushed SHA today (one-job CI since `9384092`: ~160 s/run).
- **Local main is 4 commits AHEAD, held on purpose (do not push blindly):**

| SHA | What | Deploy when pushed |
|---|---|---|
| `625a437` | Apply on approve behind an OFF switch; applier re-checks every row before a live submit (P1-6) | migration `20261105140000` FIRST, then `dispatch-apply`, then push |
| `e63f979` | A pasted link outside the work-authorised countries asks before it is added (Teja's "warn, let me confirm") | web first (push), then `job-link-intake` |
| `c4e57c0` | Indian places with a US/UK-looking state code ("Raipur, CT") resolve to India; 0 of 2,571 stored verdicts flip | screener, matcher, auditor, scout-ats, job-link-intake |
| `009f216` | Security: 11 functions verified the caller AFTER a password sign-in; now before (W15 pattern) | cover-letter, follow-up, gmail-sync, interview-prep, job-link-intake, matcher, referral, resume-assist, scout-web, skill-gap, tailor; then smoke-test one with the anon key → expect 401 |

  **Blocker:** `625a437` must not ship as is. An independent review said SHIP only after a fix-up (pending P1-1).
  The other three sit on top of it, so they wait too (or get cherry-picked onto origin/main in a worktree).
- **Uncommitted work on disk (owners stopped; NOT abandoned, CLAUDE.md §2):** see pending P1-1 (peer 2's
  P1-6 fix-up), P1-2 (peer 3's scan popup), P1-3 (peer 1's slug-prefix match). The exact paths are listed there.
- **Live counts at 14:40:** dropped_filter 33,944 · passed_filters 317 · failed 81 · awaiting_approval 44 ·
  scored 26 · approved 5 · applied 3. Master version 15.
- **post-screen drain workflow is ENABLED** (Teja did not disable it). The leak fixes were live before it ran;
  26 rows went through the new matcher pre-gate at ~14:01.
- `system_settings.dry_run` is read by NOTHING (peer 2, grep-verified); live vs dry is decided only by
  `apply.yml` inputs / `APPLYY_CRON_LIVE` (unset → scheduled applies are dry).

## Live changes made today after 01:10 (all verified)

| When (IST) | What | From |
|---|---|---|
| 12:41 | gmail-sync v6 → v7 (later v8); `APPLYY_GMAIL_SYNC_URL` set to the new Web App (digest 69504b…); "Sync now" verified ok + 60 s cooldown | Teja's explicit OK |
| 12:20–14:11 | 22 commits pushed (approval re-check, emoji removal, Manual apply Mark applied/failed, email page filters/read/Add to Applied, Gmail job alerts, Workday descriptions, CI one-job, auto-drain, screening leaks 1–3, AI chat fixes, tailor dedupe + retry, worker liveness) | `36eca2f` … `1341608` |
| 12:3x–13:22 | Migrations applied: `20261105121500` (human approved→applied/failed), `124500` (job_alert class), `124600` (read_at, discovered→applied human edge, `track_email_as_applied` RPC) | dry-run then push |
| 13:13 | Workday back-fill: 348 descriptions written (md5 348/348), 348 apps failed→passed_filters, 348 events `workday_backfill_2026_11_05`; 43 taken-down postings left failed | Teja OK |
| 13:40 | email `f34b7156` (HackerRank receipt) re-classified oa_invite → application_received (UPDATE 1) | Teja OK |
| 13:59 | Queue retro: 8 approved → failed (Cohere, Chime, Cloudflare, Plaid, Scale AI, GitLab, 2× Databricks), 2 awaiting → dropped_filter (Elastic, OpenAI); 10 events `retro_*_2026_11_05` | Teja OK |
| 14:33 | HackerRank AI Researcher Intern `cac40516-f5a8…` approved → applied (`orchestrator_on_teja_request`) | Teja asked |

Deployed today (latest versions): tailor v33, scout-ats v38 (from `2286915`), job-link-intake v8, auditor v25,
resume-assist v11, email-tracker-intake v32, gmail-sync v8, screener v30. `dispatch-apply` is NOT deployed.

## Teja's rulings today (after 01:10)

- Manual apply needs Mark applied / Mark failed (built, live). Email page: filters, sort, in-app mark-as-read
  (NOT Gmail), real class badges, "Not tracked" + Add to Applied, Link-to-existing first.
- Gmail scope: application lifecycle + recruiter + job ALERT mail from ATS, boards and companies; one-click add,
  never auto-create.
- No emojis anywhere (done; the guard decodes entities/escapes and scans dist).
- Secrets pasted into session c5's chat: **do NOT rotate** (his choice). App password pasted into this chat: rotation offered, not decided.
- "Approve unchecked" label: keep.
- Apply-on-approve: build behind an OFF switch; the first live run = ONE job; drain the rest only after it works;
  `APPLYY_CRON_LIVE` stays off until then. Per-run batch of 25 is an orchestrator engineering call (timeout safety).
- Pasted links: "warn, let me confirm" for work-auth (built in `e63f979`, held).
- Live AI e2e: target the lowest-scored awaiting_approval row, then reset + reject it; sign in via an env var.
- Orchestrator delegates its own investigations to recon agents (memory `orch-delegates-own-recon`).

## Traps learned today

- **The auto-mode classifier blocks** secret writes, live SQL writes and `gh workflow disable` unless Teja says
  yes in THIS window for that exact action. Never route around a block with another tool; ask.
- **A check that can equal its own error value passes vacuously.** My first back-fill loop compared
  "PARSE_FAIL" to "PARSE_FAIL". `supabase db query -o json` returns `{boundary, rows:[…]}`; parse `.rows`.
- **Never reconstruct an id from its prefix.** I invented the tail of `cac40516…`; a `where exists` guard made
  it a no-op. Copy full ids from a SELECT.
- **A push can cross a peer's HOLD.** Peer 3 asked to hold `5c09087` seconds after I pushed it; I rolled
  scout-ats back and the fix landed as a new commit. Before pushing a stack, confirm "ready to push" with every
  author whose commit is in it.
- **Pasted links skip every screening gate** (human-picked), and before `ea85dc9` they silently revived dropped jobs.
- **The scheduled worker scout never marked disappearances** until `1341608` (7,592 stale rows piled up).
- **Teja opens sessions unannounced** (1b, c5, d3 today). ListAgents + ownership check before every push.
- **Dependabot minutes are not billed**; the real Actions spend is ~1,800 min / 14 d before the CI cut.
