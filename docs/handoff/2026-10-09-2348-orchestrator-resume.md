# Orchestrator resume point, 2026-10-09 23:48 IST (applyyy-a1)

Supersedes the 15:11 version of this file. Re-measure everything before acting.

## Live (pushed, CI green, deployed/pushed by the orchestrator)
- origin/main = a3b4115. Today after the restart: d82fa8e (screen: exclusions title-only), 55ca959 (pregate-sweep.yml),
  cb36c7c (agent_runs reaper + runner no-op + docs + CLAUDE.md §7), f95b324 (Answer bank Save all),
  0c437e4 (worker: submit cap 3, breaker, cron behind vars.APPLYY_CRON_LIVE, OptionNotFoundError, Greenhouse title confirms),
  a3b4115 (worker: robots gate before goto; dry run logs wouldSubmit + blockers).
- Migrations live up to 20261009233000 (robots_refused enum). 220000 probe passed.
- Sweep DONE: passed_filters 1150, 5513 drop events, 0 Gemini.
- answer_bank: located_in_country=India, visa_sponsorship_required=false, employment_restrictions=None,
  language + OSS link: all attested_by_human=true (Teja saved in browser 17:45Z).
- Config: 49 titles / 22 exclusions (updated 09:37:29Z).

## 2026-10-10 UPDATE (applyyy-bc)
- 87cd5c6 CI green. Dry run 38029186613: `wouldSubmit=true blockers=0`, resume attached.
- Teja said YES (11:3x, directly) to a real submit from CI. Run 38029772194 (dry_run=false, apply_only_id=ba1e…):
  OUTCOME UNKNOWN. A POST fetch to https://boards.greenhouse.io/gitlab/jobs/8775507002 was sent; the page stayed on the form 45s; no
  confirmation. The breaker stopped the run. The row was left at `applying` (claim lease) → the sweeper moves it to needs_verification.
  NEVER resubmit blind. Likely an invisible reCAPTCHA reject from the datacenter IP.
- WAITING ON TEJA: did a GitLab/Greenhouse "thank you for applying" email arrive ~11:36 IST? Yes → mark applied in the recovery
  UI (needs_verification→applied, human). No → one LOCAL headed submit from his PC (home IP), only on his explicit go.
- Supabase MCP needs re-auth (/mcp) after the account switch on 10-10.

## Critical path: Teja's FIRST real application (GitLab, row ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154, status approved)
- CI dry run (run 37970625389 at a3b4115):
  `wouldSubmit=false blockers=1 [Country: no_matching_option]`. The phone Country picker is the ONLY blocker.
- 23:50: PUSHED 87cd5c6 (the Country fix, 2 paths). NEXT: verify CI by full SHA 87cd5c6c103118f5c620897eef6a5d03767917ba, then the dry run.
- 23:49: p3 READY (tsc 0, vitest 409/409, reviewer + red-on-revert done). Real option text "India +91" (Greenhouse bundle). SLOT GO sent;
  check `git log origin/main` for "fix(worker): Greenhouse phone Country…". If it's absent, the files are on disk:
  playwright-page.ts sha256 14b85f5c…, country-dial-option.test.ts a7145238…; re-gate and commit. Then CI → dry run. Watch the PHONE value in the
  screenshot (intl-tel-input rebuilds the number on country change).
- Was IN FLIGHT (p3 = applyyy-61): worker/src/playwright-page.ts (M) + worker/test/country-dial-option.test.ts (new).
  Spec: an anchored India/+91 match, never fuzzy ("Indiana", "British Indian Ocean Territory" must never match), >1 match → park.
  Next: finish → gates (worker tsc + vitest 0 fail) → commit → CI → dispatch
  `gh workflow run apply.yml --ref main -f dry_run=true -f apply_only_id=ba1e5d1d-84a5-4cfb-b5a6-e5a2943bf154`
  → expect `wouldSubmit=true blockers=0` → ASK TEJA for the go → real run with dry_run=false + the same apply_only_id
  (local headed is preferred for reCAPTCHA; CI works but has a datacenter IP).
- After the first `applied`: Teja sets the repo variable APPLYY_CRON_LIVE=true → cron submits approved rows (cap 3/run).

## In flight #2, uncommitted (peer 6 = applyyy-04): Greenhouse receipt email → applied (Teja chose Option A, 23:24)
- Files: supabase/functions/email-tracker-intake/{index,decide,decide.test}.ts, _shared/intake/email-contract(.test).ts,
  _shared/apps-script/email-tracker.gs, docs/setup/gmail-tracker-apps-script.md,
  packages/shared-types/src/status-flow.ts (+ test/enum-parity.test.ts),
  supabase/migrations/20261009235000_tracker_confirms_applied.sql (NOT applied).
- Mandatory: ATS vendor sender + the TOPMOST mx.google.com Authentication-Results dkim/spf pass; received after the LATEST
  entry to applying; exactly 1 candidate; slug match; event names the email_events id.
- Then: Teja re-enables the Gmail Apps Script (0 emails since 2026-09-11). Redeploy email-tracker-intake.

### Peer 6 final state (23:49): STOPPED, spec (a)-(e) all done, nothing staged
- sha256/16: 235000.sql 0a59a5f38ddb3bae · status-flow.ts 900c92af7db917a1 · enum-parity.test.ts a7d52c7cecfebaa7 ·
  intake index.ts 3d92b08ad5e6606d · decide.ts 1c991046cd8fff90 · decide.test.ts 46a95e270875da5d ·
  email-contract.ts c9f29e9ce89ccc6e · email-contract.test.ts 6fa3875ee8a46942 · email-tracker.gs d6f2294b493b50e2 ·
  docs/setup/gmail-tracker-apps-script.md 1d56e94749da55bf
- Gates: node --test functions 912/912; shared-types 27/27; deno 93==93; web + worker tsc 0; red-on-revert 10/10.
- Extra guards beyond spec: the job title must be in the subject/body; To must contain the app user email; single-address From; p_expected_updated_at.
- MISSING: (1) the delta reviewer verdict: re-run it on the 10 files; (2) PRE/POST/PROBE SQL for 235000; (3) DECISION for Teja:
  a receipt on an ALREADY-applied row moves applied→employer_screening (pre-existing, decide.test.ts:170), so it would now
  fire after almost every submit, mislabelling "screening". Recommend: a receipt on an applied row does nothing.
- 23:50 delta review: SHIP-WITH-NOTED-RISK (90/90). MUST FIX before READY, NEW-1: decide.ts addressedTo (~:489) also scans the To
  DISPLAY NAME. addressedTo('"tejamallam00@gmail.com" <evil@x.com>', owner) → true. Fix: if the header has '<', match only the
  <...> addresses. Named test with that exact string, red-on-revert. Residual: the title match is a substring; plus/dot Gmail aliases
  fail closed. VERIFY: APPLYY_APP_USER_EMAIL == the master profile identity.email (worker/src/profile-answers.ts:196), or the feature never fires.
- Teja's Gmail steps: docs/setup/gmail-tracker-apps-script.md "Re-enable after a script change" (incl. applyyInstallTrigger()).

## Decisions owed / rules
- Teja: hand-picks jobs, keeps human approval; after approval, submission is automatic.
- **SECURITY, still open:** Teja's app password was pasted into a chat transcript and equals
  his email address. Rotate it (new and strong) in THREE places: Supabase Auth, the GitHub
  secret, and the Supabase secret `APPLYY_APP_USER_PASSWORD`. Also rotate
  `SUPABASE_ACCESS_TOKEN` and `VERCEL_TOKEN` (both were pasted into chat).
- **needs_verification → approved is HELD** until Teja rules on it (2026-10-09 decision 4).
  The GitLab row routes through needs_verification; only →applied (human-confirmed) is open.
- **Mailbox mismatch risk:** docs say tejamallam00@, the master profile identity.email may be
  tejamallam1233@. VERIFY `APPLYY_APP_USER_EMAIL` == `identity.email`
  (worker/src/profile-answers.ts:196) or the email-receipt feature never fires.
- Backlog carried from pruned handoffs: `filter_rules` has 9 rows for each of 2 user_ids but
  only 1 user has applications — find the orphan's owner; GEMINI.md at repo root flagged by an
  audit (it tells agents to delete handoffs) — review it; remote branch
  `origin/wip/2026-10-06-resume-editor` and stale registered worktree
  `C:/Users/tejam/AppData/Local/Temp/applyyy-clean` are cleanup candidates.
- Deploys and db-pushes: the orchestrator only, from a pinned worktree; run the dry run as its own step (a chained one was blocked as "Blind Apply").
- Lessons today: re-read sources before briefing (a wrong path and a stale count were sent from memory); keep peer outputs
  here so a dead session forces no rework.
