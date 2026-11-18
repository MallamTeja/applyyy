# Orchestrator handoff — 2026-11-18 23:55 IST

Outgoing orch: applyyy-61. Session closed by Teja ("lets kill everything"). Read this, then the status board at the
top of `docs/handoff/2026-11-12-1305-pending-tasks.md`, then re-measure live state yourself.

## Read first

| File | What |
|---|---|
| `docs/handoff/2026-11-12-1305-pending-tasks.md` | status board: done / in progress / open with fixes |
| `docs/architecture/2026-11-18-pipeline-flow-changes.md` | what changed in the pipeline tonight and why (Teja's rulings quoted) |
| `docs/audit/2026-11-18-discovery-channels.md` | discovery channels + findings D1–D16 |
| `docs/handoff/2026-11-18-peer-{1,2,3}*.md` | per-peer bridges (r1, r2, r3) |

## Shipped tonight

- `5aeb07d0` experience + location screen leaks — deployed 21:49 (screener 48, matcher 63, auditor 57, job-link-intake 27, scout-ats 65).
- `fa315449` scouted jobs stop at Ready to tailor; no-JD rows land there with a pill; already_applied by
  provider:ats_job_id; Lever keeps lists[]; toolbar restyle — deployed ~23:05 (same 5 functions), web live
  (prod bundle has "No description"). `postscreen-drain.yml` re-enabled 23:10 (schedule = regate only).
- Final bundle (this commit): peer 2 remote-feed fixes (D6/D7/D8/D13), peer 3 deletions (adzuna, jooble, tiers,
  freshness, ingest-links.yml, worker/ingest/) + `scout-ats?mode=liveness` + `.github/workflows/scout-ats-daily.yml`
  (cron 41 1 * * * = 07:11 IST), docs. scout-ats redeployed from this commit's export so the 07:11 run finds the mode.
- Live SQL: 9 dead boards disabled (22:30); Eli Lilly 0f8e4712 moved discovered → passed_filters by the human edge (22:58).

## NOT committed — peer 1 round 3 (Workday)

Files (still modified in the working tree): `worker/src/cli/scout.ts`, `worker/src/scout/{board-pages,persist-jobs}.ts`,
`worker/test/{board-pages,persist-jobs}.test.ts`, new `worker/test/scout-robots-defer.test.ts`.
Backup: `C:\Users\tejam\applyyy-handoff-keep-11-18-2355-peer1-wip\` (copies + `peer1-wip.diff`).
State: D1 skip + pacing, D3 backfill, D10 once-a-day coded; worker tsc 0; vitest 40/40 on its files; **full vitest
and red-on-revert NOT done**. Bridge `docs/handoff/2026-11-18-peer-1-r3.md` has the counter-reset SQL (43 boards).
**Key finding:** the robots.txt 429 is Cloudflare refusing GitHub runner IPs (first Workday request already 429;
home IP gets 200). The code fix stops false failure counts but will NOT restore Workday discovery on CI.
**Decision for Teja:** Workday egress — run Workday polling from the edge function (Supabase egress) or locally,
instead of GitHub Actions. Measure the edge IP first (one robots.txt GET from scout-ats).

## Next session, first steps

1. `gh run list --commit <final sha> --workflow=ci.yml` — confirm CI green on the final bundle.
2. Check the 07:11 IST `scout-ats-daily.yml` run (19 Nov) went green; read its liveness counts.
3. Finish peer 1: full worker vitest from PowerShell at `C:\` (lowercase `c:\` cwd breaks vitest with
   "reading 'config'"), red-on-revert, then commit; then run the reset SQL; then the egress decision.
4. Open items with fixes: pending list status board (#3 rules need Teja's shape; #6 failure reasons; #7 iCIMS;
   Ramp via secondaryLocations; regate for experience; auditor history read).

## Teja's clicks still pending

- Reject Canonical `111d1ff4` (retitled copy of applied `8e9d58ce`).
- Drop the 8 ineligible rows listed in the pending file.

## Other sessions on the tree

- applyyy-11 (tailor / resume-chat) committed `b221126c` and `77ff4d03` itself; its handoff
  `docs/handoff/2026-11-18-2345-tailor-session-handoff.md` is untracked and is ITS file — not in this commit.
- jobhuntt-6b is another repo.

## Rulings captured in memory

`applyyy-scouted-jobs-stop-at-ready-to-tailor` (21:45 + 21:46). Deletions approved 22:27/22:29 (bulk links, dead code).
