> **Historical record as of 2026-10-06.** Current state: [SYSTEM_ARCHITECTURE.md](../SYSTEM_ARCHITECTURE.md) · [PROGRESS.md](../PROGRESS.md).

# Handoff — first live end-to-end application (2026-10-06)

Written by `applyyy-11` (orchestrator) at session end. Supersedes nothing; `RESUME-HERE.md`
is still the entry point but was NOT rewritten (its owner, applyyy-d3, was holding).
Every count below carries the date it was measured; regenerate before trusting it.

## Goal
One real job application submitted end to end through the system: discover → match →
tailor → audit → **human approve** → **assisted fill, human clicks Submit** → track.

## Where the target row is
- Application `ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154` — GitLab "Intermediate Backend
  Engineer, India", Greenhouse job 8775507002, app user `0f4b24da-e85b-40bb-8606-c81824493b45`.
- Status **`scored`**, `match_score` **64** (measured 2026-10-06 11:0x IST).
  Regenerate: `select status, match_score from applications where id='ba1e5d1d-…'` (Supabase MCP `execute_sql`).
- Posting live: `curl https://boards-api.greenhouse.io/v1/boards/gitlab/jobs/8775507002` → 200 (2026-10-05).

## The one blocker: Gemini capacity — needs Teja
- Tailor fails `upstream_unavailable`: `gemini-3.8-flash` returns 503 "high demand" on the tailor's
  large request (4/4 attempts, 3 runs, 2026-10-05). Small probes: 3.8 intermittent, **3.6-flash 200 in 1.6s**,
  3.7 503, 2.5-flash 404.
- **Keys 12–20 are dead**: 403 PERMISSION_DENIED "Your project has been denied access" on generateContent
  (models.get still 200). Keys 1–11 alive. Still `enabled=true` in `gemini_key_state` (20 enabled, 2026-10-06).
- Both fixes were refused by the permission classifier for the orchestrator; Teja must run them:
  ```powershell
  $env:SUPABASE_ACCESS_TOKEN = $null   # user env var holds the WRONG (aczen.in) account token
  & "C:\Users\tejam\tools\supabase\supabase.exe" secrets set GEMINI_MODEL=gemini-3.6-flash --project-ref xynqxekcqizwhtskzqrq
  ```
  ```sql
  update gemini_key_state set enabled = false
  where user_id = '0f4b24da-e85b-40bb-8606-c81824493b45' and key_index between 12 and 20;
  ```

## Then, in order
1. `gh workflow run run-one.yml -f application_id=ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154`
   — uses repo secrets, never submits; resumes at the tailor (af6f1d2). Watch with `gh run view --log`.
   Expect `scored → tailored → audit_clean|audit_flagged → awaiting_approval`.
2. Teja approves at https://applyyy.vercel.app/approvals.
3. Teja runs, locally: `node worker/src/cli/assist.ts --id ba1e5d1d-…` (env: SUPABASE_URL, SUPABASE_ANON_KEY,
   APPLYY_APP_USER_EMAIL, APPLYY_APP_USER_PASSWORD). Headed Chromium fills, **Teja clicks Submit**, answers `y`.
   Chromium 1193 is already installed locally. Avoid 08:00 IST (apply.yml dry run can hold the claim lease).
4. Legal questions (visa, work auth, located-in-India, employment agreements, prior GitLab employment)
   are deliberately never auto-filled. Open-source links + primary language have no answer source yet.

## Unverified work — saved, NOT on main
Branch **`wip/2026-10-06-peer-inflight`** (`9145369`, pushed): 20 files of in-flight peer work, untested.
Re-verify each slice (tests + red-on-revert) and land on main by explicit path:
- email tracker: false "unfortunately" rejection + `stripe.evil.com` domain match (applyyy-8b);
- dead-posting filter in tailor-batch / tailor index + edge readers (applyyy-d0) — the 5 red
  `tailor-batch.test.ts` cases at 2b5ee46 came from this edit;
- form-fill round 3 (full name, city, current company only with an explicit marker, phone synonyms,
  hCaptcha never a field) + gateway `disappeared_at` refusal (applyyy-5c);
- unclaimed `CLAUDE.md` edits (owner unknown — ask before landing).

## Landed and deployed (2026-10-04/05), for orientation
Migrations 20261004200000/210000/220000 applied. All 14 edge functions deployed from clean
`origin/main` worktrees (deploy with `env -u SUPABASE_ACCESS_TOKEN … functions deploy <fn> --use-api`;
the CLI uploads the WORKING TREE, so deploy from a clean `git worktree`). CI (`ci.yml`) green, actions SHA-pinned.
Key commits: a12bce3 (pipeline unblock) · 7ffc22a (Gemini key header, 403 rotation) · 9d62a2f (tailor schema) ·
25b4b5c (score gate 45) · 2b5ee46 (150s deadline) · 5f4115d (liveness) · 27bdbbd (profile-backed form fill) ·
af6f1d2 (run-one resume) · 314a6aa (scheduled-scout dedupe fix).

## Open decisions for Teja
- Gemini daily budget (`system_settings.gemini_daily_call_budget` is NULL = uncapped; retries cost up to 4/call).
- Second application: discovered inventory has none fillable (good fits are Ashby; robots disallows `/api/`).
  Needs the scout-web runner, which applyyy-5c's classifier refused pending Teja's direct approval.
- Email tracking: no `acknowledged` status (receipts advance to `employer_screening`); Apps Script mailbox
  (docs say tejamallam00@, profile uses tejamallam1233@); body minimisation.
- vitest 2→4 major (closes the remaining critical/high dev advisories); react-router v7.
- Remove the `SUPABASE_ACCESS_TOKEN` user env var (aczen.in account) — it silently overrides `supabase login`.
