# Orchestrator handoff — 2026-10-24 14:30 IST (from applyyy-aa)

Supersedes the 00:36 handoff, deleted as stale on 2026-10-24 (history:
`git show f44e209:docs/handoff/2026-10-24-0036-orchestrator-handoff.md`; its rescue
branches no longer exist). Re-measure before acting: every count below has its regenerating
command, and counts are timestamps, not facts.

## State at shutdown

- **Tree clean, nothing unpushed.** All 4 peers stopped clean (each confirmed `git status`
  empty for its paths). `git worktree list` = the main tree only. Branches: `main` +
  the bot's `automation-keepalive` (keep it — `keepalive.yml` force-pushes it).
- **origin/main = `78e5126`.** Verify: `git log -1 origin/main`.
- **Deployed:** scout-ats + scout-web from `7a4f12d` (boardRefusal refactor; earlier the
  https apply_url fix `d153a2a` and SmartRecruiters `7f5b120`), tailor from `9e5a6ef`.
  Web auto-deploys on push (Vercel) and **now skips docs-only commits** (`fe1dbcd`
  `ignoreCommand`). Worker code goes live on the next workflow run (it checks out main).
- **Migrations applied today:** `20261024113000_dashboard_read_paths` (index + status-count
  RPC) and `20261024124500_master_profiles_nullable_keys_present` (NOT VALID check).
- **Live counts (14:25 IST)** — regenerate with
  `select status, count(*) from applications group by 1`:
  dropped_filter 19238 · passed_filters 2522 · blocked_needs_human 4 · applying 1 ·
  needs_verification 1 · discovered 0 · deduped 0.

## What changed today (the parts a next session must know)

1. **One email everywhere** (Teja's ruling): only `tejamallam00@gmail.com`. Master **v3**
   carries it. A re-pin of an in-flight row moves THREE pins together:
   `applications.master_version`, `tailored_profile.master_version`,
   `tailor_refs.master_version` (memory `applyyy-one-email-tejamallam00`).
2. **Greenhouse captcha refuses CI submits.** 3 of 3 submits that reached the captcha
   failed (`428 code=captcha-failed`): GitLab ×2, Axiad. Nothing was stored; Greenhouse emails
   a security code each time — ignore those codes. Worker now logs response codes (`6e6ab8f`),
   records the cause on the row as an `application_events` note (`b194674`), and waits for the
   resume upload before submit (`c0504a2`).
3. **Manual apply** (`681b78e` web + `d20fa45` worker): sidebar → *Manual apply*. A kit is
   generated per row with
   `gh workflow run apply-kit.yml --ref main -f application_id=<uuid>` (no submit, no status
   write; contact identity from the latest master; values never printed to CI logs).
   The GitLab kit LANDED (run 40079846826, note at 14:25 IST): 20 fields, 6 left for Teja,
   resume "Mallam Teja Resume.pdf" re-rendered with the v3 email, 1 identity-drift warning.
4. **Planner** (`78e5126`): School/Degree/Discipline/City from the master; opinion questions
   (pronouns, onsite, relocation, "what excites you", "I understand…") fill ONLY from an
   answer_bank row with `attested_by_human = true` (live check 14:23: zero such rows existed,
   so nothing regressed).
5. **Remote feeds**: `scout-remote.yml` runs daily 07:00 IST (RemoteOK fetch-all, Jobicy
   `industry=dev`, Arbeitnow), screened at insert. First live run: 172 fetched, 10 new
   passed_filters. The browser writer was retired (`446eb60`).
6. **Approvals**: newest-in-review first (`9bf24d9`); a ✗ skill chip attests the skill into a
   new master version, then the resume (`c1e486f`).

## Open on Teja (ask, don't assume)

1. **Greenhouse CI decision — FLAGGED, Teja decides later.** Options: skip CI for Greenhouse
   (approved rows go straight to Manual apply) vs retry Sigma/Perpay once their questions are
   answered. Evidence above. Do not build the skip until he rules.
2. **Manual applications waiting** (Manual apply page): GitLab `ba1e5d1d` (needs_verification
   after sweep / applying), Axiad `3c476629` (captcha), Sigma `428f6cbc` + Perpay `634f6f48`
   (unanswered questions — kits will list them), Aiven `0fcd296f` + Bjak `3c77d7dc`
   (`unsupported_form`: embedded/other portal). Generate a kit per row before he applies.
3. After he applies by hand: mark each `applied` via "I applied" on the Manual apply page.
4. Gmail: receipts go to `tejamallam00@gmail.com` (the tracker's inbox) from now on.

## Queue (assignable without Teja)

- Generate kits for the 5 non-GitLab manual rows (one dispatch at a time — the
  `applyy-apply-kit` concurrency group keeps only one pending run).
- ~2026-10-31: `select idx_scan from pg_stat_user_indexes where indexrelname =
  'applications_user_status_created_id_idx'` — if 0, peer drafts a drop migration.
- `apps/web/vercel.json` — DELETED 2026-10-24 with Teja's OK. It was an inert duplicate of the
  root `vercel.json` (Vercel builds from the repo root); the root file is now the only CSP.
- Filler: Greenhouse typeahead (School/City) picks exact options only → may park as
  `no_matching_option` (safe direction); a fuzzy-but-verified picker is a future parcel.

## Traps that bit today

- **Push the reviewed SHA**, never the branch: `git push origin <sha>:main` (a peer committed
  27 s after a gap-check and rode out unreviewed).
- `apply.yml` / `apply-kit.yml` concurrency keeps ONE pending run — dispatch sequentially.
- A VS Code restart kills every peer session; their uncommitted work stays on disk ownerless.
- Peers MAY have the Supabase MCP; reads are fine, live writes stay with the orchestrator.
- The rtk hook truncates `git diff`; use `--no-compact` when reviewing hunks.
