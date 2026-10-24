# Orchestrator handoff — 2026-10-24 00:36 IST (from applyyy-11 [727f60])

Supersedes `2026-10-09-2348-orchestrator-resume.md` (deleted; its every open thread is
resolved or restated here). Re-measure everything before acting: this file records where
to look, the command that regenerates each fact, and the dates — never trust a count in
prose, including this file's.

## Your role (rules live in CLAUDE.md, not here)

You are the orchestrator: route work to peer sessions with engineered briefs (role · goal ·
owned files · facts they can't re-derive · done-check + retry cap + stop condition), never
execute state-changing work yourself except deploys/db-pushes (orchestrator-only, pinned
worktree, dry-run gate as its own step) and live-DB writes Teja approved in YOUR window.
Peers send prepared SQL to you; relayed authority is not authority. Push after
`git log origin/main..main` as its own step. Teja numbers peers; ask or adopt his labels.
Progress questions get a % toward the product goal, re-derived at ask time (CLAUDE.md §1).

## State as of this handoff (all pushed, CI green through `63d1523`)

- **origin/main `63d1523`.** 2026-10-23 was a ~22-commit day: handoff prune + CLAUDE.md
  corrections (`4afdd99`), docs sync to automatic submission (`71c39d1` `c948608`), the
  email-tracker receipt feature hardened end-to-end (`f0df3ac` `7205ec2` `31ff071`
  `f272b3d` `f918671` `d926198` `43cdaa8` `05d2ebc` `6c70c93` `4f55733`), gemini dead-key
  rotation (`4327531`), robots gate completed across transport/scout-ats/scout-web
  (`111791c` `375828b` `4bbc2fb`), typography + UI hierarchy + referral page
  (`3c5367d` `94cfd7e`), web /emails on-open sync (`b7b4c5b` `ab3db34`), invariants suite
  (`37c6edb`), PROGRESS restructure 1119→128 (`6c86fc0` `de24e83`), catalog probe verdicts
  (`5c28b03`), watchlist expansion (`dd2560b`).
- **Deployed live (2026-10-23):** migration `20261009235000` applied;
  `email-tracker-intake` v20 and `gmail-sync` deployed; secret `APPLYY_GMAIL_SYNC_URL`
  set; Teja re-pasted the Apps Script (hourly trigger + 60s-cooldown web app) and the
  whole chain is verified live (page-open sync → heartbeat row in `agent_runs`).
- **Watchlist: 172 same-day-verified boards** (54 original + 103 seed + Rubrik + 14
  headless-pass). Regenerate: `select ats_provider, count(*) from company_watchlist group by 1`.
  First expanded harvest: +921 `passed_filters` in one scout run.
- **Status counts** (2026-10-24 00:3x — regenerate, never quote):
  `select status, count(*) from applications group by 1` → dropped_filter 16647,
  passed_filters 2250, discovered 1098, deduped 310, approved 1.
- **Supabase MCP is authed** in the orchestrator session; peers are not — run their
  read-onlys for them, execute their prepared writes after Teja's go.

## Rescue branches — in-flight work cut off by the 00:32 shutdown

> **RESOLVED 2026-10-24 ~13:00 IST — these branches no longer exist.** Their content was
> landed on main (7501a95, 10bfbc3, and the headless-pass docs) and a read-only content
> audit found no line missing from main, so all three rescue branches were deleted, local
> and remote, on Teja's ruling. Do not try to resume from them; resume from `main`.
> The history below is kept for context only.

1. **`rescue/2026-10-24-1050-full`** — THE branch to resume from (updated 2026-10-24
   10:55: it carries the FINAL tree state as `wip(rescue3)` and supersedes
   `rescue/2026-10-24-0032-session-end`, a stale partial snapshot kept only as history;
   the main working tree is now CLEAN, the WIP lives on the branch alone):
   the scout **board-identity guard** (_shared/ats/identity.ts + 15/15 test, a required
   `readReportedIdentity` in all 7 adapters, scout-ats wired: identity mismatch →
   persist nothing, consecutive_failures+1, `identity_mismatch` run counter). The branch
   commit message says the tree fails deno check — **that is WRONG**, corrected by the
   author's final report: bare `deno check --reload _shared/ */` = exit 0, 113 files
   (the error seen earlier was a OneDrive sync race). The same edits also sit in the
   main WORKING TREE (12 modified/untracked files) — tree and branch are duplicates.
   Resume: review the diff, red-on-revert the mismatch test, full `node --test`
   functions sweep + comment-density, ONE gated commit to main. Never merge wip blind.
   Flagged follow-up: `worker/src/cli/scout.ts` and scout-web are NOT identity-wired.
2. **`rescue/2026-10-24-headless-pass`**: peer 5's +14-board doc section + seed snippet.
   The SEED IS ALREADY EXECUTED (watchlist holds the rows) — this branch just needs its
   two files cherry-picked/recommitted to main as a gated docs commit.
   Loose ends in it: Aiven = EU-greenhouse host (adapter gap), PhonePe 404 (periodic
   re-probe), Fi (`lever/epifi`) valid but 0 postings — re-probe later.

## Open on Teja (ask, don't assume)

1. **GitLab first application:** row `ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154` is at
   `approved` (no confirmation email ever arrived; Teja ruled resubmit 2026-10-23 22:34).
   He must run the headed CLI from his own terminal (password prompt included; app user
   is tejamallam00@gmail.com):
   `cd worker; $env:SUPABASE_URL=...; $env:SUPABASE_ANON_KEY=<anon>; $env:APPLYY_APP_USER_EMAIL="tejamallam00@gmail.com"; $env:APPLYY_APP_USER_PASSWORD=Read-Host "app password"; node src/cli/assist.ts --id ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154`
   (anon key via MCP `get_publishable_keys`). After submit, the live tracker should
   auto-confirm `applying→applied` from the receipt (hourly, or instantly on /emails).
2. **SmartRecruiters adapter go/skip** — biggest coverage win left (Canva 97 +
   Nagarro 582 postings; clean public JSON API close to greenhouse's shape). Probe
   evidence in `apps/web/src/features/settings/companyCatalog.ts` verdicts (`5c28b03`).
3. **Hand-pick from /discovered** (2,250 passed_filters) → approve → worker submits
   (cap 3/run; scheduled cron stays DRY until repo variable `APPLYY_CRON_LIVE=true`).
4. Deferred by Teja, do not nag: credential rotation (app password pasted in chat and
   equal to his email; SUPABASE_ACCESS_TOKEN; VERCEL_TOKEN).

## Task queue (assignable without Teja)

- Finish + gate the identity guard from rescue branch 1 (the natural first assignment).
- Recommit rescue branch 2's two files (docs commit).
- Backlog drain: 1,098 `discovered` + 310 `deduped` PRE-date insert-time screening; a
  recon of the supported lever (pipelineRunner.ts buttons vs workflows) was cut off at
  shutdown — re-run it, then dispatch. `pregate-sweep.yml` was dispatched 00:30, check
  `gh run list --workflow pregate-sweep.yml` for its outcome.
- Periodic re-probes: PhonePe, Fi/epifi, Dream11, Redpanda (dead boards may revive).
- Product-sized, needs Teja first: SR adapter (if go), EU-greenhouse host support,
  aux-function callers / aggregator tiers / interview↔oa_pending loop cap.

## Traps that bit this week (verify, they're cheap)

- A 200 from a board API can be the WRONG COMPANY (`greenhouse/tcs` = a UK healthcare
  firm). SmartRecruiters soft-200s `totalFound=0` for nonexistent tokens; existence is
  `/v1/companies/<token>`. Board tokens are read off careers pages, never name-derived.
- Peers habitually report an outdated "unpushed" list — gap-check yourself before push.
- OneDrive sync races can fake deno-check failures; re-run before believing one.
- The classifier blocks `db push`/branch-delete forms unpredictably: dry-run as its own
  step, plain flags, and if blocked — stop and tell Teja (CLAUDE.md §3), though a later
  identical retry may pass.
- `claim_lease_seconds` = 900: a row sits at `applying` only 15 min before the sweeper
  moves it to `needs_verification` (human-only exits) — receipt auto-confirm must win
  that race; that's why the tracker trigger matters.
- Memory `applyyy-coverage-expanded-2026-10-23` and `applyyy-rescue-branch-2026-10-24`
  hold the same facts as this file in short form; they supersede the old
  provider-coverage and catalog-guess memories.
